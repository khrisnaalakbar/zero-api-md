import ytdl from '@distube/ytdl-core';
import { PassThrough, Readable } from 'stream';

export class VideoDownloadError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'VideoDownloadError';
  }
}

interface VideoOptions {
  quality?: 'highest' | 'lowest' | 'highestvideo' | 'lowestvideo';
  filter?: 'audioandvideo' | 'videoandaudio';
}

export class YouTubeService {
  private readonly agentOptions: ytdl.getInfoOptions;

  constructor() {
    this.agentOptions = {
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      },
    };
  }

  public validateUrl(url: string): boolean {
    try {
      return ytdl.validateURL(url);
    } catch {
      return false;
    }
  }

  public async getVideoInfo(url: string): Promise<ytdl.videoInfo> {
    if (!this.validateUrl(url)) {
      throw new VideoDownloadError('Invalid YouTube URL provided', 'INVALID_URL');
    }

    try {
      const info = await ytdl.getInfo(url, this.agentOptions);
      
      if (info.videoDetails.isPrivate) {
        throw new VideoDownloadError('Video is private', 'VIDEO_PRIVATE');
      }

      if (info.videoDetails.age_restricted) {
      }

      return info;
    } catch (error: any) {
      if (error instanceof VideoDownloadError) throw error;
      throw new VideoDownloadError(error.message || 'Failed to fetch video metadata', 'METADATA_FETCH_FAILED');
    }
  }

  public async downloadMp4(url: string): Promise<{ stream: Readable; title: string; size: number }> {
    const info = await this.getVideoInfo(url);
    
    const format = ytdl.chooseFormat(info.formats, {
      quality: 'highest',
      filter: (format) => {
        return (
          format.container === 'mp4' &&
          format.hasAudio === true &&
          format.hasVideo === true
        );
      },
    });

    if (!format) {
      throw new VideoDownloadError('No suitable MP4 (Audio+Video) format found', 'FORMAT_UNAVAILABLE');
    }

    try {
      const stream = ytdl.downloadFromInfo(info, {
        format: format,
        highWaterMark: 1 << 25, 
        dlChunkSize: 0, 
      });

      const passThrough = new PassThrough();
      
      stream.on('error', (err) => {
        passThrough.emit('error', new VideoDownloadError(err.message, 'STREAM_ERROR'));
      });

      stream.pipe(passThrough);

      return {
        stream: passThrough,
        title: info.videoDetails.title.replace(/[^\w\s]/gi, ''),
        size: format.contentLength ? parseInt(format.contentLength) : 0,
      };

    } catch (error: any) {
      throw new VideoDownloadError(error.message || 'Download stream initialization failed', 'DOWNLOAD_INIT_FAILED');
    }
  }
}

export const ytService = new YouTubeService();


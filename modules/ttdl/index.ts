import * as fs from 'fs';
import * as path from 'path';
import axios, { AxiosInstance, ResponseType } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import inquirer from 'inquirer';
import chalk from 'chalk';
import figlet from 'figlet';
import ora, { Ora } from 'ora';
import Table from 'cli-table3';

interface DownloadStat {
    type: string;
    id: string | number;
    author: string;
    status: 'Success' | 'Failed';
    details: string;
}

interface VideoData {
    authorUniqueId: string;
    videoId: string;
    createTime: number;
    videoUrl: string;
    description?: string;
}

interface ApiResult {
    status: string;
    result?: any;
    [key: string]: any;
}

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MOBILE_USER_AGENT = "TikTok 26.2.0 rv:262018 (iPhone; iOS 14.4.2; en_US) Cronet";
const TIKTOK_URL_REGEX = /^https?:\/\/(www\.|vm\.|vt\.)?(tiktok\.com)\/?(.*)$/;
const API_URL = "https://api-tiktok-downloader.vercel.app/api/v4/download";
const VIDEO_DIR = "./tiktok-videos";
const IMAGE_DIR = "./tiktok-images";

const cookieJar = new CookieJar();
const instance: AxiosInstance = wrapper(
    axios.create({
        withCredentials: true,
        jar: cookieJar,
    })
);

const downloadStats: DownloadStat[] = [];

const formatUploadDate = (timestamp: number): string => {
    const createdDate = new Date(timestamp * 1000);
    return `${createdDate.getDate().toString().padStart(2, "0")}${(createdDate.getMonth() + 1).toString().padStart(2, "0")}${createdDate.getFullYear()}`;
};

const ensureDirectoryExists = (dirPath: string): void => {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
};

const validateURL = (url: string): boolean => {
    if (!url || typeof url !== "string") return false;
    return TIKTOK_URL_REGEX.test(url);
};

const downloadFile = async (url: string, referer: string, responseType: ResponseType = "arraybuffer"): Promise<any> => {
    try {
        const response = await instance(url, {
            headers: { Referer: referer, "User-Agent": USER_AGENT },
            responseType: responseType,
        });
        return response.data;
    } catch (error) {
        throw error;
    }
};

const handleHtml = async (url: string): Promise<string> => {
    try {
        let res = await instance(url, { headers: { "User-Agent": USER_AGENT } });
        return res.data;
    } catch (e: any) {
        throw new Error(e.message || String(e));
    }
};

const getMediaInfoFromAPI = async (url: string): Promise<any> => {
    try {
        const apiUrl = `${API_URL}?url=${encodeURIComponent(url)}`;
        const response = await instance.get<ApiResult>(apiUrl, {
            headers: { "User-Agent": MOBILE_USER_AGENT },
        });
        if (response.data.status !== "success") throw new Error(`API Error: ${response.data.status}`);
        return response.data.result;
    } catch (error) {
        throw error;
    }
};

const downloadImages = async (url: string, imageId: string | number, imageUrls: string[], timestamp: number, authorId: string, spinner: Ora): Promise<void> => {
    try {
        const requestHeaders = { Referer: url, "User-Agent": USER_AGENT };
        ensureDirectoryExists(IMAGE_DIR);
        
        let successCount = 0;
        for (let i = 0; i < imageUrls.length; i++) {
            spinner.text = `Downloading Image ${i + 1}/${imageUrls.length}...`;
            const imageUrl = imageUrls[i];
            const response = await instance(imageUrl, {
                headers: requestHeaders,
                responseType: "arraybuffer",
            });
            const formattedDate = formatUploadDate(timestamp);
            const fileName = `${authorId}_img_${formattedDate}_${imageId}_${i + 1}.jpg`;
            fs.writeFileSync(path.join(IMAGE_DIR, fileName), response.data);
            successCount++;
        }
        
        downloadStats.push({
            type: 'Photo Slide',
            id: imageId,
            author: authorId,
            status: 'Success',
            details: `${successCount} Images`
        });
        
    } catch (error: any) {
        downloadStats.push({ type: 'Photo', id: imageId || 'Unknown', author: authorId || 'Unknown', status: 'Failed', details: error.message });
        throw error;
    }
};

const downloadVideo = async (videoData: VideoData, url: string): Promise<string> => {
    try {
        const videoBuffer = await downloadFile(videoData.videoUrl, url);
        const formattedDate = formatUploadDate(videoData.createTime);
        const fileName = `${videoData.authorUniqueId}_vid_${formattedDate}_${videoData.videoId}.mp4`;
        
        ensureDirectoryExists(VIDEO_DIR);
        fs.writeFileSync(path.join(VIDEO_DIR, fileName), videoBuffer);
        
        downloadStats.push({
            type: 'Video',
            id: videoData.videoId,
            author: videoData.authorUniqueId,
            status: 'Success',
            details: 'MP4 Saved'
        });
        
        return fileName;
    } catch (error: any) {
        downloadStats.push({ type: 'Video', id: videoData.videoId || 'Unknown', author: videoData.authorUniqueId || 'Unknown', status: 'Failed', details: error.message });
        throw error;
    }
};

const extractVideoDataFromJson = (rawJSON: string): VideoData | null => {
    try {
        const parsedJSON = JSON.parse(rawJSON);
        const videoDetail = parsedJSON?.__DEFAULT_SCOPE__?.["webapp.video-detail"];
        if (!videoDetail) return null;
        
        const itemStruct = videoDetail.itemInfo?.itemStruct;
        if (!itemStruct) return null;
        
        const { author, video } = itemStruct;
        if (!author || !video) return null;

        let videoUrl = video.playAddr;
        if (video.bitrateInfo?.length > 0 && video.bitrateInfo[0].PlayAddr?.UrlList?.[0]) {
            videoUrl = video.bitrateInfo[0].PlayAddr.UrlList[0];
        }

        return {
            authorUniqueId: author.uniqueId,
            videoId: itemStruct.id,
            createTime: itemStruct.createTime,
            videoUrl: videoUrl,
            description: itemStruct.desc,
        };
    } catch (error) {
        return null;
    }
};

const processUrl = async (url: string): Promise<void> => {
    const spinner = ora('Analyzing URL...').start();
    
    try {
        if (!validateURL(url)) {
            spinner.fail(chalk.red('Invalid TikTok URL format!'));
            return;
        }

        if (url.includes("/photo/")) {
            spinner.text = 'Fetching photo metadata via API...';
            const photoData = await getMediaInfoFromAPI(url);
            
            if (photoData.type !== "image" || !photoData.images) {
                throw new Error("Invalid photo data structure");
            }

            spinner.text = `Found ${photoData.images.length} images. Starting download...`;
            await downloadImages(url, photoData.id, photoData.images, photoData.createTime, photoData.author.username, spinner);
            spinner.succeed(chalk.green('Photo slide downloaded successfully!'));
            return;
        }

        spinner.text = 'Attempting direct HTML extraction...';
        let videoData: VideoData | null = null;
        let method = 'HTML';
        
        try {
            const html = await handleHtml(url);
            const $ = cheerio.load(html);
            const jsonDataElement = $("#__UNIVERSAL_DATA_FOR_REHYDRATION__");
            
            if (jsonDataElement.length > 0) {
                const child: any = jsonDataElement[0]?.children?.[0];
                const rawJSON = child?.data;
                if (rawJSON) videoData = extractVideoDataFromJson(rawJSON);
            }
        } catch (ignored) {}

        if (!videoData) {
            spinner.text = 'HTML extraction failed. Switching to API backup...';
            method = 'API';
            const apiData = await getMediaInfoFromAPI(url);
            
            if (apiData.type !== "video" || !apiData.video?.playAddr) {
                throw new Error("API failed to retrieve video data");
            }
            
            videoData = {
                authorUniqueId: apiData.author.username,
                videoId: apiData.id,
                createTime: apiData.createTime,
                videoUrl: apiData.video.playAddr[0],
            };
        }

        spinner.text = `Downloading video (${method})...`;
        await downloadVideo(videoData, url);
        spinner.succeed(chalk.green('Video downloaded successfully!'));

    } catch (error: any) {
        spinner.fail(chalk.red(`Error: ${error.message}`));
    }
};

const showBanner = (): void => {
    console.clear();
    console.log(chalk.magenta(figlet.textSync('TikTok DL', { horizontalLayout: 'full' })));
    console.log(chalk.cyan('--------------------------------------------------'));
    console.log(chalk.yellow('      Simple CLI Downloader by RehanDias'));
    console.log(chalk.cyan('--------------------------------------------------\n'));
};

const showSummary = (): void => {
    if (downloadStats.length === 0) return;

    const table = new Table({
        head: [chalk.cyan('Type'), chalk.cyan('Author'), chalk.cyan('Status'), chalk.cyan('Details')],
        colWidths: [15, 20, 15, 30]
    });

    downloadStats.forEach(stat => {
        table.push([
            stat.type,
            stat.author,
            stat.status === 'Success' ? chalk.green(stat.status) : chalk.red(stat.status),
            stat.details
        ]);
    });

    console.log('\n' + chalk.bold.white('SESSION SUMMARY:'));
    console.log(table.toString());
};

const main = async (): Promise<void> => {
    showBanner();
    
    let keepRunning = true;

    while (keepRunning) {
        const answers = await inquirer.prompt<{ url: string }>([
            {
                type: 'input',
                name: 'url',
                message: chalk.yellow('Masukkan tautan TikTok:'),
                validate: (input: string) => input.length > 0 ? true : 'URL tidak boleh kosong!'
            }
        ]);

        await processUrl(answers.url.trim());

        const confirm = await inquirer.prompt<{ again: boolean }>([
            {
                type: 'confirm',
                name: 'again',
                message: 'Apakah ingin download lagi?',
                default: false
            }
        ]);

        keepRunning = confirm.again;
    }

    showSummary();
    console.log(chalk.magenta('\nTerima kasih telah menggunakan TikTok Downloader!'));
    process.exit(0);
};

main();



import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import { S3Client, type BunRequest } from "bun";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo, type Video } from "../db/videos";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getAssetDiskPath, getAssetURL, mediaTypeToExt } from "./assets";
import { randomBytes } from "crypto";
import { unlink } from "fs/promises";

const MAX_UPLOAD_SIZE = 1 << 30;

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
	const { videoId } = req.params as { videoId?: string };
	if (!videoId) {
		throw new BadRequestError("Invalid video ID");
	}
	// authenticate user to get userId
	const token = getBearerToken(req.headers);
	const userId = validateJWT(token, cfg.jwtSecret);

	const video = getVideo(cfg.db, videoId);
	if (!video) {
		throw new NotFoundError("Unauthorized");
	}

	if (video.userID !== userId) {
		throw new UserForbiddenError("Unauthorized");
	}

	const formData = await req.formData();
	const file = formData.get("video");
	if (!(file instanceof File)) {
		throw new BadRequestError("Video missing");
	}

	if (file.size > MAX_UPLOAD_SIZE) {
		throw new BadRequestError("File is too big");
	}

	const mediaType = file.type;
	if (!mediaType) {
		throw new BadRequestError("File is missing");
	}

	if (mediaType !== "video/mp4") {
		throw new BadRequestError("Invalid file type, only videos allowed");
	}

	const fileExtension = mediaTypeToExt(mediaType);
	const fileName = `${randomBytes(32).toString("hex")}${fileExtension}`;
	const assetDiskPath = getAssetDiskPath(cfg, fileName);

	let s3Key;
	let processedVideo;

	try {
		await Bun.write(assetDiskPath, file);
		const aspectRatio = await getVideoAspectRatio(assetDiskPath);
		s3Key = `${aspectRatio}/${fileName}`;
		processedVideo = await processVideoForFastStart(assetDiskPath);
		await cfg.s3Client.file(s3Key).write(Bun.file(processedVideo));
	} finally {
		await unlink(assetDiskPath);
		if (processedVideo) {
			await unlink(processedVideo);
		}
	}
	// video.videoURL = videoUrl;
	// const videoUrl = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${s3Key}`;
	const videoKey = `${s3Key}`;

	video.videoURL = videoKey;
	console.log("video url before sending to db: ", video);
	updateVideo(cfg.db, video);
	const signedVideo = dbVideoToSignedVideo(cfg, video);

	return respondWithJSON(200, signedVideo);
}

export async function getVideoAspectRatio(filePath: string) {
	// use Bun.spawn to run the ffprobe command
	// command: ffprobe -v error -select_streams v:0 -show-entries stream=width height -of json filepath
	const proc = Bun.spawn([
		"ffprobe",
		"-v",
		"error",
		"-select_streams",
		"v:0",
		"-show_entries",
		"stream=width,height",
		"-of",
		"json",
		filePath,
	]);
	// console log whatever cursed thing comse back

	// Configure Bun.spawn to send results to stdout and sterr
	const stdoutText = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;

	console.log("StdoutText: ", stdoutText);
	console.log("stdouterr: ", stderr);
	console.log("Exit code: ", exitCode);
	// check if the exited result if it's not 0 it's an error
	if (exitCode !== 0) {
		throw new Error("Bun spawned an error");
	}

	const parsed = JSON.parse(stdoutText);
	const stream = parsed.streams?.[0];

	const { width, height } = stream;
	const ratio = width / height;

	// parse the stdout of the command and get the height and width
	// determine the aspect ratio returned
	// landscape (16:9) portrait(9:16) - use Math.floor if things are off
	const ratioFloor = Math.floor((width / height) * 100);
	if (ratioFloor === 177) {
		console.log(`${filePath} is being saved as landscape with ${ratioFloor}`);
		return "landscape";
	}
	if (ratioFloor === 56) {
		console.log(`${filePath} is being saved as portrait with ${ratioFloor}`);
		return "portrait";
	}
	return "other";
}

export async function processVideoForFastStart(inputFilePath: string) {
	// create a new string for outputfilepath - append the .processed to the file input
	// this is the path to the temp file on disk
	// use bun.spawn to create a new process
	// command: ffmpeg -i, inputFilePath, -movflags, faststart, -map_metadata, 0, -codec, copy, -f, mp4, outputFilePath
	const outputFilePath = `${inputFilePath}.processed`;
	const proc = Bun.spawn([
		"ffmpeg",
		"-i",
		inputFilePath,
		"-movflags",
		"faststart",
		"-map_metadata",
		"0",
		"-codec",
		"copy",
		"-f",
		"mp4",
		outputFilePath,
	]);
	// run the command
	const stdoutText = await new Response(proc.stdout).text();
	console.log("stdoutText: ", stdoutText);
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		throw new Error(
			`Bun spawned an error with exit code ${exitCode}: ${stderr}`,
		);
	}
	// return output filePath
	return outputFilePath;
}

export function generatePresignedURL(
	cfg: ApiConfig,
	key: string,
	expireTime: number,
) {
	// use Bun's S3Client.presign to generate presigned URL
	const presignedURL = cfg.s3Client.presign(key, {
		expiresIn: expireTime,
	});
	// return presign URL
	return presignedURL;
}

export function dbVideoToSignedVideo(cfg: ApiConfig, video: Video) {
	// take a video as input and return video with presigned URL
	// use current VideoURL containing key value
	console.log(video);
	const url = video.videoURL;
	if (!url) {
		return video;
	}
	// generatePresigned URL for video
	const presignedURL = generatePresignedURL(cfg, url, 3600);
	video.videoURL = presignedURL;
	return video;
	// set the VideoURL field as the presigned URL
	// return the updated video
}

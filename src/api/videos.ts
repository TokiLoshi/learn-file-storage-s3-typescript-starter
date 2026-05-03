import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import { S3Client, type BunRequest } from "bun";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
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
	const fileName = `${randomBytes(32).toString("hex")}.${fileExtension}`;
	const assetDiskPath = getAssetDiskPath(cfg, fileName);

	try {
		await Bun.write(assetDiskPath, file);
		await cfg.s3Client.file(fileName).write(Bun.file(assetDiskPath));
	} finally {
		await unlink(assetDiskPath);
	}

	const videoUrl = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${fileName}`;
	video.videoURL = videoUrl;
	const updatedVideo = updateVideo(cfg.db, video);

	return respondWithJSON(200, null);
}

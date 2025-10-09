import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getAssetDiskPath, getAssetURL, mediaTypeToExt } from "./assets";

const MAX_UPLOAD_SIZE = 10 << 20;

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
	const { videoId } = req.params as { videoId?: string };
	if (!videoId) {
		throw new BadRequestError("Invalid video ID");
	}

	const token = getBearerToken(req.headers);
	const userID = validateJWT(token, cfg.jwtSecret);

	const video = getVideo(cfg.db, videoId);
	if (!video) {
		throw new NotFoundError("Video not found");
	}
	if (video.userID !== userID) {
		throw new UserForbiddenError("Unauthorized");
	}

	// TODO: implement the upload here
	const formData = await req.formData();
	const file = formData.get("thumbnail");
	if (!(file instanceof File)) {
		throw new BadRequestError("Thumbnail file missing");
	}

	if (file.size > MAX_UPLOAD_SIZE) {
		throw new BadRequestError("File is too big");
	}

	const mediaType = file.type;
	if (!mediaType) {
		throw new BadRequestError("Missing Content-Type");
	}

	const fileExtension = mediaTypeToExt(mediaType);

	const fileName = `${videoId}${fileExtension}`;
	const assetDiskPath = getAssetDiskPath(cfg, fileName);
	await Bun.write(assetDiskPath, file);

	// const thumbnailUrl = `http://localhost:${cfg.port}/assets/${fileName}`;
	const urlPath = getAssetURL(cfg, fileName);

	video.thumbnailURL = urlPath;

	const updatedVideo = updateVideo(cfg.db, video);
	console.log("Updated video: ", updatedVideo);

	return respondWithJSON(200, video);
}

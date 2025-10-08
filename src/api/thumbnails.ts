import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";

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

	const data = await file.arrayBuffer();
	const buffer = Buffer.from(data);
	const base64String = buffer.toString("base64");
	const dataURL = `data:${mediaType};base64,${base64String}`;

	const thumbnailUrl = `http://localhost:8091/api/thumbnails/${videoId}`;

	video.thumbnailURL = dataURL;

	const updatedVideo = updateVideo(cfg.db, video);
	console.log("Updated video: ", updatedVideo);

	return respondWithJSON(200, video);
}

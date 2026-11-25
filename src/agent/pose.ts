import { db, type ImageRecord } from '../db/schema';
import { saveImage } from '../db/repo';
import { describePose, framePose, parsePoseJson, poseLabel, renderPose, type Pose } from '../lib/pose';

/** The keypoints stored on a pose image, if it has them (a plain skeleton PNG has none). */
export function poseOf(rec: ImageRecord | undefined): Pose | undefined {
  const p = rec?.params?.pose;
  return p && Array.isArray(p.people) ? (p as Pose) : undefined;
}

/** Imports a pose file (3D Openpose Editor scene or OpenPose JSON) as a pose image in the project. */
export async function importPoseFile(projectId: string, file: File, aspect: number): Promise<ImageRecord> {
  const pose = parsePoseJson(await file.text(), aspect);
  const h = 768, w = Math.round((h * pose.aspect) / 8) * 8;
  const blob = await renderPose(framePose(pose, pose.aspect, false), w, h);
  return saveImage(projectId, blob, { op: 'pose', prompt: file.name, params: { pose, label: poseLabel(pose), description: describePose(pose) } });
}

export interface PoseInput {
  /** skeleton image at the generation size */
  image: Blob;
  /** the pose in words ('' for a skeleton image without keypoints) */
  description: string;
  imageId: string;
}

/** The pose for one generation: drawn at the output size (fitted to the frame unless turned off) and described. */
export async function poseFor(imageId: string, width: number, height: number, o: { style?: 'tags' | 'natural'; fit?: boolean } = {}): Promise<PoseInput | undefined> {
  const rec = await db.images.get(imageId);
  if (!rec) return undefined;
  const pose = poseOf(rec);
  if (!pose) return { image: rec.blob, description: '', imageId };
  const framed = framePose(pose, width / height, o.fit ?? true);
  return { image: await renderPose(framed, width, height), description: describePose(framed, o.style ?? 'natural'), imageId };
}

/** Adds the pose description to a prompt (once). */
export function withPoseText(prompt: string, description: string, tags: boolean): string {
  if (!description || prompt.includes(description)) return prompt;
  return tags ? `${prompt.trim().replace(/[,\s]+$/, '')}, ${description}` : `${prompt.trim()}\n\n${description}`;
}

/** Instruction for models that get the skeleton as a reference image. */
export const POSE_IMAGE_NOTE =
  'The last reference image is an OpenPose pose skeleton (coloured lines are limbs, dots are joints, black background). Draw the subject in exactly that pose, at that position and size in the frame. Never draw the skeleton, lines or dots themselves.';

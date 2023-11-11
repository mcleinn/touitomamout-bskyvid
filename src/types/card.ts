import { ComAtprotoRepoUploadBlob } from "@atproto/api";

export type BlueskyCard = {
  uri: string;
  title: string;
  description: string;
  thumb: ComAtprotoRepoUploadBlob.Response | null;
};

import DiscussionContent from "./DiscussionContent";
import { getDiscussion } from "@/lib/api";

export default async function DiscussionPage() {
  const data = await getDiscussion().catch(() => ({
    posts: [],
    blogs: [],
    videos: [],
    photos: [],
    projects: [],
    vodSites: [],
    stats: { totalPosts: 0, blogCount: 0, videoCount: 0, photoCount: 0, vodSiteCount: 0, uniqueAuthors: 0 },
  }));
  return <DiscussionContent data={data} />;
}

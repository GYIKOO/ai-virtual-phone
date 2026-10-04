import { notFound } from "next/navigation";
import StoryControlsPreview from "@/components/story/story-controls-preview";

export default function Page() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <StoryControlsPreview />;
}

import { useState } from "react";
import { ImageOff } from "lucide-react";
import { thumbnail } from "../format";

export function VideoThumb({
  postId,
  url,
  alt,
  className = "",
}: {
  postId: string;
  url?: string | null;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className={`thumb-placeholder ${className}`} aria-label={alt}>
        <ImageOff size={18} />
      </div>
    );
  }
  return (
    <img
      className={`video-thumb ${className}`}
      src={thumbnail(postId, url)}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

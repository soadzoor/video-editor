export async function loadVideoMetadata(
  url: string
): Promise<{ duration: number; width: number; height: number }> {
  const video = document.createElement("video");
  video.preload = "metadata";

  return new Promise((resolve, reject) => {
    const handleLoaded = () => {
      const metadata = {
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        width: video.videoWidth || 0,
        height: video.videoHeight || 0
      };
      cleanup();
      resolve(metadata);
    };

    const handleError = () => {
      cleanup();
      reject(new Error("Unable to read video metadata."));
    };

    const cleanup = () => {
      video.removeEventListener("loadedmetadata", handleLoaded);
      video.removeEventListener("error", handleError);
      video.src = "";
    };

    video.addEventListener("loadedmetadata", handleLoaded);
    video.addEventListener("error", handleError);
    video.src = url;
  });
}

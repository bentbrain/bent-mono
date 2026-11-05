import {
  DESIGN_SOURCE_CONTENT_TYPES,
  MAX_DESIGN_SOURCE_BYTES,
  MAX_DESIGN_SOURCE_EDGE,
  MAX_DESIGN_SOURCE_PIXELS,
} from "@forever-tee/contracts/limits";

export const IMAGE_UPLOAD_ACCEPT = DESIGN_SOURCE_CONTENT_TYPES.join(",");

export async function prepareImageUpload(file: File): Promise<File> {
  if (!DESIGN_SOURCE_CONTENT_TYPES.includes(file.type)) {
    throw new Error("Choose a JPEG, PNG or WebP image.");
  }
  if (file.size === 0 || file.size > MAX_DESIGN_SOURCE_BYTES) {
    throw new Error("Choose an image no larger than 20 MB.");
  }
  // Read dimensions without allocating a full-resolution bitmap or canvas on
  // the phone. The server applies orientation and removes metadata before storage.
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => { resolve(); };
      image.onerror = () => { reject(new Error("This image could not be opened. Choose another image.")); };
      image.src = url;
    });
    if (image.naturalWidth > MAX_DESIGN_SOURCE_EDGE || image.naturalHeight > MAX_DESIGN_SOURCE_EDGE ||
      image.naturalWidth * image.naturalHeight > MAX_DESIGN_SOURCE_PIXELS) {
      throw new Error("Choose an image up to 50 megapixels and 12,000 pixels per side.");
    }
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

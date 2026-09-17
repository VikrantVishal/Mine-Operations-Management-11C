import { db, collection, doc, setDoc, serverTimestamp } from "./firebase-config.js";

const PHOTO_COLLECTION = "photos";
const MAX_WARN_FILE_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_ACCEPT_FILE_BYTES = 60 * 1024 * 1024; // 60 MB
const THUMB_MAX_LONG_SIDE = 600;
const STANDARD_DIMENSIONS = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 }
};

// HEIC/HEIF (iPhone photo format) support — the canvas/Image pipeline
// below can't decode HEIC/HEIF directly in any current browser, so files
// in that format are converted to JPEG in the background, up front,
// before they enter the normal processing pipeline. From that point on
// they're indistinguishable from a JPEG the user selected directly.
const HEIC_TO_CDN_URL = 'https://cdn.jsdelivr.net/npm/heic-to@1.5.2/+esm';
let heicToModulePromise = null;
function loadHeicToModule() {
  if (!heicToModulePromise) {
    heicToModulePromise = import(HEIC_TO_CDN_URL);
  }
  return heicToModulePromise;
}

function hasHeicExtension(file) {
  const name = (file.name || '').toLowerCase();
  return name.endsWith('.heic') || name.endsWith('.heif');
}

function hasHeicNameOrType(file) {
  const type = (file.type || '').toLowerCase();
  return type === 'image/heic' || type === 'image/heif' ||
    type === 'image/heic-sequence' || type === 'image/heif-sequence' ||
    hasHeicExtension(file);
}

// Decides whether a file needs HEIC->JPEG conversion. Files with a clear,
// non-HEIC image MIME type (jpeg/png/webp/etc) skip the check entirely, so
// normal uploads never pay the cost of loading the conversion library.
// Anything else is confirmed by inspecting the actual file bytes rather
// than trusting the filename or a possibly-missing MIME type — iOS/Safari
// and some file pickers report an empty or generic type for HEIC files.
async function isHeicFile(file) {
  const type = (file.type || '').toLowerCase();
  if (type.startsWith('image/') && !hasHeicNameOrType(file)) {
    return false;
  }
  try {
    const { isHeic } = await loadHeicToModule();
    return await isHeic(file);
  } catch (err) {
    // Conversion library failed to load (e.g. offline) — fall back to the
    // filename/MIME heuristic so we don't block an otherwise-valid photo.
    return hasHeicNameOrType(file);
  }
}

async function convertHeicToJpeg(file) {
  const { heicTo } = await loadHeicToModule();
  const blob = await heicTo({ blob: file, type: 'image/jpeg', quality: 0.92 });
  const baseName = (file.name || 'photo').replace(/\.(heic|heif)$/i, '');
  return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' });
}

function isSupportedImage(file) {
  if (!file) return false;
  const type = (file.type || '').toLowerCase();
  if (type.startsWith('image/')) return true;
  // iOS/Safari and some file pickers report an empty or generic MIME type
  // for HEIC/HEIF files — fall back to the filename extension so these
  // aren't rejected before we get a chance to detect and convert them.
  return hasHeicExtension(file);
}

function generatePhotoId() {
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const suffix = String(Math.floor(Math.random() * 900000 + 100000));
  return `PHOTO-${date}-${suffix}`;
}

function storagePath(reportSection, photoId, thumb = false, ext = 'webp') {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const folder = `photos/${year}/${month}/${reportSection}`;
  return `${folder}/${photoId}${thumb ? '_thumb' : ''}.${ext}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

async function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image could not be loaded')); 
    img.src = src;
  });
}

function detectOrientation(width, height) {
  return width >= height ? 'landscape' : 'portrait';
}

function cropArea(width, height, targetRatio) {
  let cropWidth = width;
  let cropHeight = height;
  const sourceRatio = width / height;

  if (sourceRatio > targetRatio) {
    cropWidth = Math.round(height * targetRatio);
  } else {
    cropHeight = Math.round(width / targetRatio);
  }

  return {
    x: Math.round((width - cropWidth) / 2),
    y: Math.round((height - cropHeight) / 2),
    width: cropWidth,
    height: cropHeight
  };
}

function createStandardCanvas(img, orientation) {
  const target = STANDARD_DIMENSIONS[orientation];
  const ratio = target.width / target.height;
  const crop = cropArea(img.width, img.height, ratio);
  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, crop.x, crop.y, crop.width, crop.height, 1, 1, canvas.width - 2, canvas.height - 2);
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2;
  ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
  return canvas;
}

function createThumbnailCanvas(img, orientation) {
  const target = STANDARD_DIMENSIONS[orientation];
  const ratio = target.width / target.height;
  const crop = cropArea(img.width, img.height, ratio);
  const longest = Math.max(crop.width, crop.height);
  const scale = Math.min(1, THUMB_MAX_LONG_SIDE / longest);
  const thumbWidth = Math.round(crop.width * scale);
  const thumbHeight = Math.round(crop.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, thumbWidth);
  canvas.height = Math.max(1, thumbHeight);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const drawW = Math.max(0, canvas.width - 2);
  const drawH = Math.max(0, canvas.height - 2);
  ctx.drawImage(img, crop.x, crop.y, crop.width, crop.height, 1, 1, drawW, drawH);
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2;
  ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
  return canvas;
}

async function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, mimeType, quality);
  });
}

async function canvasToBestBlob(canvas) {
  let blob = await canvasToBlob(canvas, 'image/webp', 0.82);
  if (!blob || !blob.type.includes('webp')) {
    blob = await canvasToBlob(canvas, 'image/jpeg', 0.88);
  }
  if (!blob) {
    throw new Error('Image compression failed');
  }
  return blob;
}

function fileExtensionFromMime(mimeType) {
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('png')) return 'png';
  return 'bin';
}

function createModal() {
  let overlay = document.querySelector('.photo-upload-modal');
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.className = 'modal-ov photo-upload-modal';
  overlay.innerHTML = `<div class="modal">
      <div class="modal-hd">
        <div><div class="modal-title">Standardise & caption photo</div></div>
        <button type="button" class="modal-x" aria-label="Close">✕</button>
      </div>
      <div class="modal-body"></div>
      <div class="modal-ft"></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.modal-x').onclick = () => overlay.dispatchEvent(new CustomEvent('photo-upload-cancel'));
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.dispatchEvent(new CustomEvent('photo-upload-cancel'));
  });
  return overlay;
}

function openModal({ previewDataUrl, orientation, originalName, originalSize, targetWidth, targetHeight }) {
  return new Promise((resolve, reject) => {
    const overlay = createModal();
    const body = overlay.querySelector('.modal-body');
    const footer = overlay.querySelector('.modal-ft');
    body.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:14px;">
        <div style="font-size:13px;color:var(--muted);">
          Orientation: <strong>${orientation}</strong> · Target: <strong>${targetWidth}×${targetHeight}</strong><br>
          Original: <strong>${originalName}</strong> · ${formatBytes(originalSize)}
        </div>
        <div style="width:100%;display:flex;justify-content:center;">
          <img class="photo-preview-img" src="${previewDataUrl}" alt="Photo preview">
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <label class="photo-caption-label" for="photo-caption-input">Caption (required)</label>
          <textarea id="photo-caption-input" rows="3" placeholder="Enter a clear caption for this photo" style="width:100%;padding:12px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface2);color:var(--text);resize:vertical;"></textarea>
          <div style="font-size:12px;color:var(--muted);">Caption will appear with the photograph in reports and galleries.</div>
        </div>
      </div>`;
    footer.innerHTML = `<button type="button" class="btn btn-ghost modal-cancel">Cancel</button><button type="button" class="btn btn-primary modal-save">Save photo</button>`;

    const cleanup = () => {
      overlay.classList.remove('open');
      setTimeout(() => { body.innerHTML = ''; footer.innerHTML = ''; }, 210);
    };

    const saveButton = footer.querySelector('.modal-save');
    const cancelButton = footer.querySelector('.modal-cancel');
    const captionInput = body.querySelector('#photo-caption-input');

    const onCancel = () => {
      cleanup();
      resolve(null);
    };
    const onSave = () => {
      const caption = captionInput.value.trim();
      if (!caption) {
        captionInput.focus();
        captionInput.style.borderColor = 'var(--red)';
        return;
      }
      cleanup();
      resolve(caption);
    };

    overlay.addEventListener('photo-upload-cancel', onCancel, { once: true });
    cancelButton.addEventListener('click', onCancel, { once: true });
    saveButton.addEventListener('click', onSave, { once: true });
    captionInput.addEventListener('input', () => captionInput.style.borderColor = '');
    overlay.classList.add('open');
    captionInput.focus();
  });
}

// ADD THIS NEW FUNCTION:
async function uploadToCloudinary(blob) {
  // Replace these with your actual Cloudinary details
  const CLOUD_NAME = 'nwc5u7hk';
  const UPLOAD_PRESET = 'mine_tracker_preset';

  const url = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/auto/upload`;
  const formData = new FormData();
  formData.append('file', blob);
  formData.append('upload_preset', UPLOAD_PRESET);

  try {
    // Important: do NOT set Content-Type or other custom headers here —
    // using plain FormData prevents a preflight in most cases.
    const response = await fetch(url, {
      method: 'POST',
      body: formData,
      mode: 'cors',
      credentials: 'omit'
    });

    const text = await response.text();
    if (!response.ok) {
      // Try to surface useful server-provided error details.
      let msg = `Cloudinary upload failed: ${response.status} ${response.statusText}`;
      try {
        const j = JSON.parse(text);
        if (j.error && j.error.message) msg += ` — ${j.error.message}`;
      } catch (e) {
        if (text) msg += ` — ${text}`;
      }
      throw new Error(msg);
    }

    const data = JSON.parse(text);
    // Cloudinary returns the live URL as 'secure_url'
    return { url: data.secure_url, size: data.bytes, mimeType: data.format, public_id: data.public_id };
  } catch (err) {
    // Add actionable hint for common CORS/root-cause issues.
    throw new Error(`${err.message}. Ensure the upload preset is configured for unsigned uploads and that you're calling the correct Cloudinary cloud name/endpoint from the browser.`);
  }
}


async function savePhotoMetadata(metadata) {
  const photoDoc = doc(collection(db, PHOTO_COLLECTION), metadata.photoId);
  const stored = {
    ...metadata,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  await setDoc(photoDoc, stored);
}

function getModalFallbackMessage(message) {
  if (typeof window.showToast === 'function') {
    window.showToast(message, 'err');
    return;
  }
  alert(message);
}

async function processPhotoFile(file, reportId, reportSection, uploadedBy) {
  if (!isSupportedImage(file)) {
    throw new Error('Only image files are supported.');
  }
  if (file.size > MAX_ACCEPT_FILE_BYTES) {
    throw new Error('This file is too large to upload. Please choose a smaller photograph.');
  }
  if (file.size > MAX_WARN_FILE_BYTES) {
    const ok = window.confirm('This photo is large and will be processed before upload. Continue?');
    if (!ok) throw new Error('Upload cancelled by user.');
  }

  // iPhone photos are commonly HEIC/HEIF, which no browser can decode via
  // <img>/canvas. Convert to JPEG here, automatically and up front, so
  // every step after this — preview, crop, thumbnail, compression,
  // caption, upload — runs through the exact same pipeline as any other
  // photo, with no format-specific branching below this point.
  let workingFile = file;
  if (await isHeicFile(file)) {
    try {
      workingFile = await convertHeicToJpeg(file);
    } catch (err) {
      throw new Error('This HEIC/HEIF photo could not be converted. Please try again, or export it as JPEG and upload that instead.');
    }
  }

  let dataUrl;
  try {
    dataUrl = await readFileAsDataURL(workingFile);
  } catch (err) {
    throw new Error('This photo could not be read. Please choose a different photo.');
  }
  let img;
  try {
    img = await loadImage(dataUrl);
  } catch (err) {
    throw new Error('This photo appears to be corrupted or in an unsupported format. Please choose a different photo.');
  }
  const orientation = detectOrientation(img.width, img.height);
  const standardCanvas = createStandardCanvas(img, orientation);
  const previewDataUrl = standardCanvas.toDataURL('image/png');
  const caption = await openModal({
    previewDataUrl,
    orientation,
    originalName: file.name,
    originalSize: file.size,
    targetWidth: STANDARD_DIMENSIONS[orientation].width,
    targetHeight: STANDARD_DIMENSIONS[orientation].height
  });
  if (caption === null) {
    throw new Error('Photo upload was cancelled.');
  }

  const thumbCanvas = createThumbnailCanvas(img, orientation);
  const photoBlob = await canvasToBestBlob(standardCanvas);
  const thumbBlob = await canvasToBestBlob(thumbCanvas);
  const photoId = generatePhotoId();
  const ext = fileExtensionFromMime(photoBlob.type);
  const thumbExt = fileExtensionFromMime(thumbBlob.type);
  const photoPath = storagePath(reportSection, photoId, false, ext);
  const thumbPath = storagePath(reportSection, photoId, true, thumbExt);

  const [photoUpload, thumbUpload] = await Promise.all([
    uploadToCloudinary(photoBlob),
    uploadToCloudinary(thumbBlob)
  ]);


  const metadata = {
    photoId,
    reportId,
    reportSection,
    caption,
    orientation,
    width: STANDARD_DIMENSIONS[orientation].width,
    height: STANDARD_DIMENSIONS[orientation].height,
    fileSize: photoBlob.size,
    format: photoBlob.type,
    storagePath: photoPath,
    downloadURL: photoUpload.url,
    thumbnailPath: thumbPath,
    thumbnailURL: thumbUpload.url,
    displayURL: photoUpload.url || thumbUpload.url,
    thumbnailSize: thumbBlob.size,
    uploadedBy: uploadedBy || null,
    processedAt: new Date().toISOString(),
    processingVersion: 1,
    border: { color: '#000', width: 1 }
  };

  await savePhotoMetadata(metadata);
  return metadata;
}

async function uploadFiles({ files, reportId, reportSection, uploadedBy, onUploaded }) {
  const fileArray = Array.from(files);
  for (const file of fileArray) {
    try {
      const photo = await processPhotoFile(file, reportId, reportSection, uploadedBy);
      if (typeof onUploaded === 'function') {
        onUploaded(photo);
      }
    } catch (err) {
      if (err.message && !err.message.includes('cancelled')) {
        getModalFallbackMessage(err.message);
      }
    }
  }
}

export const PhotoUploader = {
  uploadFiles
};

window.PhotoUploader = PhotoUploader;

/** Shared mutable state — import and mutate this object everywhere. */
export const state = {
  img: null, // loaded HTMLImageElement (first queued image)
  currentImageFile: null,
  selectedImageIndex: 0,
  scale: 1, // display scale: original px → canvas px
  imgNaturalWidth: 0,
  imgNaturalHeight: 0,

  cropX: 0,
  cropY: 0,
  cropW: 0,
  cropH: 0,
  selectionActive: false,

  dragActive: false,
  dragType: null, // 'move' | edge/corner strings
  dragStartMouse: { x: 0, y: 0 },
  dragStartCrop: { x: 0, y: 0, w: 0, h: 0 },

  imageFiles: [], // File[] queue — up to 610 images
  alternateHorizontalMargin: false,
  activeCropMode: "bounds",
  globalOutputs: {
    bounds: null, // { left, top, width, height }
    suraHeaderBlob: null,
    suraHeaderRect: null,
    suraHeaderIgnore: null,
    ayaSeparatorBlob: null,
    ayaSeparatorRect: null,
    ayaSeparatorIgnore: null,
  },
  exportImages: true,
  exportCoordinates: false,
  startSura: 1,
  startAya: 1,
};

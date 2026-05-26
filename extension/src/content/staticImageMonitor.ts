// SafeView — staticImageMonitor.ts
// Purpose: Back-compat re-exports — implementation lives in imageMonitor.ts.

export {
  IMAGE_ID_OFFSET,
  getImageById,
  handleStaticImageFrameAnalysisDone,
  isStaticImageId,
  rescanStaticImages,
  startImageMonitor,
  startStaticImageMonitor,
  stopImageMonitor,
  stopStaticImageMonitor,
} from "./imageMonitor";

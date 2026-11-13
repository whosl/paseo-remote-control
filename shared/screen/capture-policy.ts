export const captureFps = (quality: number) => quality >= 0.75 ? 15 : quality >= 0.55 ? 24 : 30;

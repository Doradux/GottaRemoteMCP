declare module "screenshot-desktop" {
  interface ScreenshotOptions {
    format?: "png" | "jpg";
    filename?: string;
    screen?: number | string;
  }
  function screenshot(options?: ScreenshotOptions): Promise<Buffer>;
  export default screenshot;
}

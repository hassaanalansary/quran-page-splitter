/** A line's label raster: which blob each pixel is, 0 for the background. */
export type Raster = { ids: Uint32Array; width: number; height: number };

/** Paint a line's ink into a layer at (dx, dy): each pixel's blob, by `colour`, which
 * says nothing for ink that is not drawn. Through a scratch canvas, so the line's
 * empty pixels leave its neighbours' ink alone where the boxes overlap. */
export function paint(
  context: CanvasRenderingContext2D,
  raster: Raster,
  dx: number,
  dy: number,
  colour: (id: number, x: number) => readonly [number, number, number] | null,
) {
  if (!raster.width || !raster.height) return;
  const image = new ImageData(raster.width, raster.height);
  const data = image.data;
  for (let i = 0; i < raster.ids.length; i++) {
    const id = raster.ids[i];
    if (!id) continue;
    const rgb = colour(id, i % raster.width);
    if (!rgb) continue;
    const p = i * 4;
    data[p] = rgb[0];
    data[p + 1] = rgb[1];
    data[p + 2] = rgb[2];
    data[p + 3] = 255;
  }
  const scratch = document.createElement("canvas");
  scratch.width = raster.width;
  scratch.height = raster.height;
  scratch.getContext("2d")?.putImageData(image, 0, 0);
  context.drawImage(scratch, dx, dy);
}

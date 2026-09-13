/**
 * 计算 Worker：把 ShRec3D 全流程放到后台线程，避免阻塞界面。
 * 直接复用 core.mjs —— 与 Deno CLI 完全同一份实现。
 */
import { coordinatesToCsv, matrixToCsv, runShrec3d } from "./core.mjs";

self.addEventListener("message", (event) => {
  const { id, text } = event.data;
  if (typeof id !== "number" || typeof text !== "string") return;

  try {
    const result = runShrec3d(text, {
      onStage: (stage, ratio) => {
        self.postMessage({ id, type: "progress", stage, ratio });
      },
    });

    self.postMessage(
      {
        id,
        type: "done",
        payload: {
          size: result.size,
          pairs: result.pairs,
          bins: result.labels.length,
          labels: result.labels,
          coordinates: result.coordinates,
          matrixCsv: matrixToCsv(result.matrix.data, result.size),
          coordinatesCsv: coordinatesToCsv(result.coordinates, result.size),
        },
      },
      [result.labels.buffer, result.coordinates.buffer],
    );
  } catch (error) {
    self.postMessage({
      id,
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

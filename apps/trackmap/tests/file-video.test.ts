import { afterAll, expect, mock, test } from "bun:test";
import { FileVideo } from "../src/file-video";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const decoder = Object.getOwnPropertyDescriptor(globalThis, "VideoDecoder");
Object.defineProperty(globalThis, "VideoDecoder", {
  configurable: true,
  value: function () {},
});
afterAll(() => {
  if (decoder) Object.defineProperty(globalThis, "VideoDecoder", decoder);
  else Reflect.deleteProperty(globalThis, "VideoDecoder");
});

const pixels = new WeakMap<object, string>();
const oldRead = deferred();
const oldWaiting = deferred();
const newRead = deferred();
const newWaiting = deferred();
let sessions = 0;
let disposed = false;

mock.module("mediabunny", () => ({
  ALL_FORMATS: [],
  BlobSource: class {},
  Input: class {
    getPrimaryVideoTrack() {
      return Promise.resolve({
        canDecode: async () => true,
        getFirstTimestamp: async () => 0,
        computeDuration: async () => 1,
      });
    }
    dispose() {
      disposed = true;
    }
  },
  CanvasSink: class {
    private pool = [
      { width: 2, height: 2 },
      { width: 2, height: 2 },
    ];
    private index = 0;
    getCanvas() {
      const canvas = { width: 2, height: 2 };
      pixels.set(canvas, "initial");
      return Promise.resolve({ canvas, timestamp: 0, duration: 1 });
    }
    private frame(value: string, timestamp: number) {
      const canvas = this.pool[this.index++ % this.pool.length];
      pixels.set(canvas, value);
      return { canvas, timestamp, duration: 0.5 };
    }
    async *canvases() {
      if (++sessions === 1) {
        yield this.frame("old-0", 0);
        oldWaiting.resolve();
        await oldRead.promise;
        yield this.frame("old-late", 0.5);
      } else {
        yield this.frame("new-0", 0);
        newWaiting.resolve();
        await newRead.promise;
        yield this.frame("new-1", 0.5);
      }
    }
  },
}));

test("replacement playback waits for stale reads before reusing the canvas pool", async () => {
  const video = await FileVideo.open(new Blob());
  if (!video) throw new Error("Missing file video");
  const first = video.play();
  await oldWaiting.promise;
  expect(pixels.get(video.canvas)).toBe("old-0");
  video.pause();
  const replacement = video.play();
  // Let the replacement reach any pending decoder read without real timers.
  for (let step = 0; step < 40; step++) await Promise.resolve();
  const overlappingSessions = sessions;
  // Always release the old read, even when the old implementation overlaps.
  oldRead.resolve();
  await first;
  await newWaiting.promise;
  expect(overlappingSessions).toBe(1);
  expect(pixels.get(video.canvas)).toBe("new-0");
  newRead.resolve();
  for (let step = 0; step < 40; step++) await Promise.resolve();
  expect(pixels.get(video.canvas)).toBe("new-0");
  video.pause();
  await replacement;
  expect(pixels.get(video.canvas)).toBe("new-0");
  video.release();
  expect(disposed).toBe(true);
});

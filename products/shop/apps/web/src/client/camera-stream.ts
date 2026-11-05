export type CameraFacing = "user" | "environment";

// A browser permission request can remain pending after navigation or timeout.
// Always release a late result rather than leaving an invisible camera running.
export async function requestCameraStream(video: MediaTrackConstraints): Promise<MediaStream> {
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const request = navigator.mediaDevices.getUserMedia({ audio: false, video });
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      reject(new Error("The camera request took too long."));
    }, 10_000);
  });
  void request.then(stream => {
    if (timedOut) stream.getTracks().forEach(track => { track.stop(); });
  }, () => undefined);
  try {
    return await Promise.race([request, deadline]);
  } finally {
    clearTimeout(timeout);
  }
}

export async function hasMultipleCameras(): Promise<boolean> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return new Set(devices.filter(device => device.kind === "videoinput")
      .map(device => device.deviceId).filter(Boolean)).size > 1;
  } catch {
    // Device discovery must not prevent taking a photo with the granted camera.
    return false;
  }
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const API_URL = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

type CaptureState = "loading" | "camera" | "review" | "sending" | "success" | "error";
type CaptureSide = "rear" | "front";

function tokenFromPath() {
  const match = window.location.pathname.match(/\/capture\/([^/]+)/);
  return match?.[1] ?? "";
}

function App() {
  const publicToken = useMemo(tokenFromPath, []);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rearPreviewRef = useRef<string | null>(null);
  const frontPreviewRef = useRef<string | null>(null);
  const [state, setState] = useState<CaptureState>("loading");
  const [message, setMessage] = useState("Opening camera");
  const [rearPreview, setRearPreview] = useState<string | null>(null);
  const [frontPreview, setFrontPreview] = useState<string | null>(null);
  const [rearBlob, setRearBlob] = useState<Blob | null>(null);
  const [frontBlob, setFrontBlob] = useState<Blob | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [facingMode, setFacingMode] = useState<CaptureSide>("rear");
  const [captureSide, setCaptureSide] = useState<CaptureSide>("rear");

  const clearPreview = useCallback((side: CaptureSide) => {
    if (side === "rear" && rearPreviewRef.current) {
      URL.revokeObjectURL(rearPreviewRef.current);
      rearPreviewRef.current = null;
    }
    if (side === "front" && frontPreviewRef.current) {
      URL.revokeObjectURL(frontPreviewRef.current);
      frontPreviewRef.current = null;
    }
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraReady(false);
  }, []);

  const startCamera = useCallback(async (mode: CaptureSide) => {
    stopCamera();
    setFacingMode(mode);
    setState("loading");
    setMessage(mode === "rear" ? "Rear camera readying" : "Front camera readying");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: mode === "rear" ? "environment" : "user" },
        width: { ideal: 1440 },
        height: { ideal: 1920 }
      }
    });
    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
    }
    setCameraReady(true);
    setState("camera");
    setMessage(mode === "rear" ? "Take the rear shot" : "Take the front shot");
  }, [stopCamera]);

  const captureFrame = useCallback(async (mode: CaptureSide) => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !cameraReady) return null;

    const maxWidth = 1440;
    const ratio = video.videoWidth > maxWidth ? maxWidth / video.videoWidth : 1;
    canvas.width = Math.round(video.videoWidth * ratio);
    canvas.height = Math.round(video.videoHeight * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.save();
    if (mode === "front") {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.restore();

    return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
  }, [cameraReady]);

  useEffect(() => {
    let mounted = true;

    async function boot() {
      if (!publicToken) {
        setState("error");
        setMessage("Invalid QR code.");
        return;
      }

      const qrResponse = await fetch(`${API_URL}/api/qr/${publicToken}`);
      if (!qrResponse.ok) {
        setState("error");
        setMessage("This QR code is not recognized.");
        return;
      }

      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setState("error");
        setMessage("Camera access requires HTTPS on mobile. Open the HTTPS link, trust the local certificate, then reload.");
        return;
      }

      try {
        if (!mounted) return;
        await startCamera("rear");
      } catch (err) {
        const name = err instanceof DOMException ? err.name : "CameraError";
        setState("error");
        setMessage(name === "NotAllowedError"
          ? "Camera access was denied. Allow camera permissions in your browser settings, then reload."
          : "Camera could not be opened. Check HTTPS, camera permissions, and reload.");
      }
    }

    boot();
    return () => {
      mounted = false;
      stopCamera();
      clearPreview("rear");
      clearPreview("front");
    };
  }, [clearPreview, publicToken, startCamera, stopCamera]);

  async function reverseCamera() {
    if (state !== "camera") return;
    const nextMode: CaptureSide = facingMode === "rear" ? "front" : "rear";
    setMessage(nextMode === "rear" ? "Switching to rear camera" : "Switching to front camera");
    try {
      await startCamera(nextMode);
      setCaptureSide(nextMode);
    } catch {
      setMessage("Camera switch failed. Your browser may expose only one camera.");
    }
  }

  async function capture() {
    if (state !== "camera") return;
    const blob = await captureFrame(facingMode);
    if (!blob) {
      setState("error");
      setMessage("The photo could not be prepared.");
      return;
    }

    const previewUrl = URL.createObjectURL(blob);
    if (captureSide === "rear") {
      clearPreview("rear");
      rearPreviewRef.current = previewUrl;
      setRearPreview(previewUrl);
      setRearBlob(blob);
      setCaptureSide("front");
      setMessage("Flip for the front shot");
      try {
        await startCamera("front");
      } catch (err) {
        setState("error");
        setMessage(err instanceof Error ? err.message : "Front camera could not be opened.");
      }
      return;
    }

    clearPreview("front");
    frontPreviewRef.current = previewUrl;
    setFrontPreview(previewUrl);
    setFrontBlob(blob);
    setState("review");
    setMessage("BeReal pair ready");
    stopCamera();
  }

  async function send() {
    if (!rearBlob || !frontBlob) return;
    setState("sending");
    setMessage("Sending both shots");
    const form = new FormData();
    form.append("photoFront", rearBlob, `saudade-front-${Date.now()}.jpg`);
    form.append("photoBack", frontBlob, `saudade-back-${Date.now()}.jpg`);
    form.append("captureSource", "camera-canvas");
    form.append("captureMode", "bereal");
    form.append("captureTimestamp", new Date().toISOString());

    const response = await fetch(`${API_URL}/api/capture/${publicToken}/upload`, {
      method: "POST",
      body: form
    });

    if (response.ok) {
      setState("success");
      setMessage("Pair sent.");
      stopCamera();
      clearPreview("rear");
      clearPreview("front");
      return;
    }

    const body = await response.json().catch(() => ({}));
    setState("review");
    setMessage(body.message ?? "Upload failed. Try again in a moment.");
  }

  function retake() {
    clearPreview("rear");
    clearPreview("front");
    setRearPreview(null);
    setFrontPreview(null);
    setRearBlob(null);
    setFrontBlob(null);
    setCaptureSide("rear");
    setMessage("Opening rear camera");
    setState("loading");
    void startCamera("rear").catch(() => {
      setState("error");
      setMessage("Camera could not be reopened.");
    });
  }

  return (
    <main className="shell">
      <section className="brand">
        <div className="brandIdentity">
          <img className="brandIcon" src="/logo.png" alt="" aria-hidden="true" />
          <p>Saudade</p>
        </div>
        <span>wear the signal</span>
      </section>

      <section className="cameraPanel" aria-live="polite">
        {(state === "loading" || state === "camera") && (
          <video ref={videoRef} className={`camera ${facingMode === "front" ? "frontCamera" : ""}`} playsInline muted />
        )}
        {state === "review" || state === "sending" ? (
          <div className="pairPreview">
            <div className="pairFrame">
              <span className="pairLabel">Rear</span>
              <img className="pairImage" src={rearPreview ?? ""} alt="Rear photo preview" />
            </div>
            <div className="pairFrame">
              <span className="pairLabel">Front</span>
              <img className="pairImage" src={frontPreview ?? ""} alt="Front photo preview" />
            </div>
          </div>
        ) : null}
        {state === "camera" && (
          <button className="reverseButton" onClick={reverseCamera} type="button" disabled={!cameraReady}>
            Flip camera
          </button>
        )}
        {state === "success" && <div className="successMark">Sent</div>}
        {state === "error" && <div className="errorMark">{message}</div>}
      </section>

      {message && state !== "error" ? <p className="status">{message}</p> : null}

      <div className="actions">
        {state === "camera" && (
          <button className="primary" onClick={capture} disabled={!cameraReady}>
            {captureSide === "rear" ? "Capture rear" : "Capture front"}
          </button>
        )}
        {state === "review" && (
          <>
            <button className="secondary" onClick={retake}>Retake pair</button>
            <button className="primary" onClick={send}>Send pair</button>
          </>
        )}
        {state === "sending" && <button className="primary" disabled>Sending...</button>}
        {state === "error" && <button className="primary" onClick={() => window.location.reload()}>Try again</button>}
      </div>

      <details className="terms">
        <summary>Terms of use</summary>
        <p>
          By sending a photo, you confirm that you have consent from every identifiable person in the image and that the photo does not contain pornographic, sexual, hateful, violent, illegal, harassing, plagiarized, copyrighted, impersonating, or privacy-invasive content.
        </p>
        <p>
          Saudade may remove abusive uploads and block repeated misuse. Do not upload photos that exploit minors, expose private information, or violate someone else's rights.
        </p>
      </details>

      <canvas ref={canvasRef} hidden />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

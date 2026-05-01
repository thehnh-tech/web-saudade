import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const API_URL = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

type CaptureState = "loading" | "camera" | "preview" | "sending" | "success" | "error";

function tokenFromPath() {
  const match = window.location.pathname.match(/\/capture\/([^/]+)/);
  return match?.[1] ?? "";
}

function App() {
  const publicToken = useMemo(tokenFromPath, []);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<CaptureState>("loading");
  const [message, setMessage] = useState("Opening camera");
  const [preview, setPreview] = useState<string | null>(null);
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");

  const startCamera = useCallback(async (mode: "environment" | "user") => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    setCameraReady(false);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: mode },
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
    setMessage("");
  }, []);

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
        await startCamera(facingMode);
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
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [publicToken, startCamera]);

  async function reverseCamera() {
    if (state !== "camera") return;
    const nextMode = facingMode === "environment" ? "user" : "environment";
    setFacingMode(nextMode);
    setMessage("Switching camera");
    try {
      await startCamera(nextMode);
    } catch {
      setMessage("Camera switch failed. Your browser may expose only one camera.");
    }
  }

  async function capture() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !cameraReady) return;

    const maxWidth = 1440;
    const ratio = video.videoWidth > maxWidth ? maxWidth / video.videoWidth : 1;
    canvas.width = Math.round(video.videoWidth * ratio);
    canvas.height = Math.round(video.videoHeight * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.save();
    if (facingMode === "user") {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.restore();

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
    if (!blob) {
      setState("error");
      setMessage("The photo could not be prepared.");
      return;
    }
    setPhotoBlob(blob);
    setPreview(URL.createObjectURL(blob));
    setState("preview");
  }

  async function send() {
    if (!photoBlob) return;
    setState("sending");
    setMessage("Sending");
    const form = new FormData();
    form.append("photo", photoBlob, `saudade-${Date.now()}.jpg`);
    form.append("captureSource", "camera-canvas");
    form.append("captureTimestamp", new Date().toISOString());

    const response = await fetch(`${API_URL}/api/capture/${publicToken}/upload`, {
      method: "POST",
      body: form
    });

    if (response.ok) {
      setState("success");
      setMessage("Photo sent.");
      streamRef.current?.getTracks().forEach((track) => track.stop());
      return;
    }

    const body = await response.json().catch(() => ({}));
    setState("preview");
    setMessage(body.message ?? "Upload failed. Try again in a moment.");
  }

  function retake() {
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setPhotoBlob(null);
    setMessage("");
    setState("camera");
  }

  return (
    <main className="shell">
      <section className="brand">
        <p>Saudade</p>
        <span>wear the signal</span>
      </section>

      <section className="cameraPanel" aria-live="polite">
        {(state === "loading" || state === "camera") && (
          <video ref={videoRef} className={`camera ${facingMode === "user" ? "frontCamera" : ""}`} playsInline muted />
        )}
        {state === "preview" || state === "sending" ? (
          <img className="camera" src={preview ?? ""} alt="Captured photo preview" />
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
            Capture
          </button>
        )}
        {state === "preview" && (
          <>
            <button className="secondary" onClick={retake}>Retake</button>
            <button className="primary" onClick={send}>Send</button>
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

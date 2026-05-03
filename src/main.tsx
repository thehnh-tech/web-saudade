import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const API_URL = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

type CaptureState = "loading" | "camera" | "review" | "sending" | "success" | "error";
type CaptureMode = "double" | "front" | "back";
type CameraFacing = "environment" | "user";
type ReviewSide = "primary" | "secondary";

function tokenFromPath() {
  const match = window.location.pathname.match(/\/capture\/([^/]+)/);
  return match?.[1] ?? "";
}

function App() {
  const publicToken = useMemo(tokenFromPath, []);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const primaryPreviewRef = useRef<string | null>(null);
  const secondaryPreviewRef = useRef<string | null>(null);
  const singlePreviewRef = useRef<string | null>(null);
  const [state, setState] = useState<CaptureState>("loading");
  const [mode, setMode] = useState<CaptureMode>("double");
  const [message, setMessage] = useState("Opening camera");
  const [cameraFacing, setCameraFacing] = useState<CameraFacing>("environment");
  const [stage, setStage] = useState<"primary" | "secondary" | "single">("primary");
  const [reviewSide, setReviewSide] = useState<ReviewSide>("primary");
  const [primaryPreview, setPrimaryPreview] = useState<string | null>(null);
  const [secondaryPreview, setSecondaryPreview] = useState<string | null>(null);
  const [singlePreview, setSinglePreview] = useState<string | null>(null);
  const [primaryBlob, setPrimaryBlob] = useState<Blob | null>(null);
  const [secondaryBlob, setSecondaryBlob] = useState<Blob | null>(null);
  const [singleBlob, setSingleBlob] = useState<Blob | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [activeStream, setActiveStream] = useState<MediaStream | null>(null);

  const clearPreview = useCallback((ref: MutableRefObject<string | null>, setter: (value: string | null) => void) => {
    if (ref.current) {
      URL.revokeObjectURL(ref.current);
      ref.current = null;
    }
    setter(null);
  }, []);

  const clearAllPreviews = useCallback(() => {
    clearPreview(primaryPreviewRef, setPrimaryPreview);
    clearPreview(secondaryPreviewRef, setSecondaryPreview);
    clearPreview(singlePreviewRef, setSinglePreview);
    setPrimaryBlob(null);
    setSecondaryBlob(null);
    setSingleBlob(null);
  }, [clearPreview]);

  const stopCamera = useCallback(() => {
    setActiveStream((current) => {
      current?.getTracks().forEach((track) => track.stop());
      return null;
    });
    setCameraReady(false);
  }, []);

  const startCamera = useCallback(async (facing: CameraFacing, prompt?: string) => {
    stopCamera();
    setCameraFacing(facing);
    setState("loading");
    setMessage(prompt ?? (facing === "environment" ? "Rear camera readying" : "Front camera readying"));
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 1440 },
        height: { ideal: 1920 }
      }
    });
    setActiveStream(stream);
    setCameraReady(true);
    setState("camera");
    setMessage(prompt ?? (facing === "environment" ? "Capture the rear shot" : "Capture the front shot"));
  }, [mode, stage, stopCamera]);

  const configureMode = useCallback(async (nextMode: CaptureMode) => {
    setMode(nextMode);
    clearAllPreviews();
    setReviewSide("primary");
    setStage(nextMode === "double" ? "primary" : "single");
    try {
      await startCamera(
        nextMode === "front" ? "user" : "environment",
        nextMode === "double" ? "Capture the rear shot" : nextMode === "front" ? "Capture the front shot" : "Capture the back shot"
      );
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "CameraError";
      setState("error");
      setMessage(name === "NotAllowedError"
        ? "Camera access was denied. Allow camera permissions in your browser settings, then reload."
        : "Camera could not be opened. Check HTTPS, camera permissions, and reload.");
    }
  }, [clearAllPreviews, startCamera]);

  const captureFrame = useCallback(async () => {
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
    if (cameraFacing === "user") {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.restore();

    return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
  }, [cameraFacing, cameraReady]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || state !== "camera" || !activeStream) return;
    video.srcObject = activeStream;
    void video.play().catch(() => undefined);
    return () => {
      if (video.srcObject === activeStream) {
        video.srcObject = null;
      }
    };
  }, [activeStream, state]);

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
        await configureMode("double");
      } catch {
        if (!mounted) return;
        setState("error");
        setMessage("Camera could not be opened. Check HTTPS, camera permissions, and reload.");
      }
    }

    boot();
    return () => {
      mounted = false;
      stopCamera();
      clearAllPreviews();
    };
  }, [clearAllPreviews, configureMode, publicToken, stopCamera]);

  async function capture() {
    if (state !== "camera") return;
    const blob = await captureFrame();
    if (!blob) {
      setState("error");
      setMessage("The photo could not be prepared.");
      return;
    }

    const previewUrl = URL.createObjectURL(blob);
    if (mode === "double") {
      if (stage === "primary") {
        clearPreview(primaryPreviewRef, setPrimaryPreview);
        primaryPreviewRef.current = previewUrl;
        setPrimaryPreview(previewUrl);
        setPrimaryBlob(blob);
        setStage("secondary");
        setMessage("Now capture the front shot");
        try {
          await startCamera("user", "Capture the front shot");
        } catch (err) {
          setState("error");
          setMessage(err instanceof Error ? err.message : "Front camera could not be opened.");
        }
        return;
      }

      clearPreview(secondaryPreviewRef, setSecondaryPreview);
      secondaryPreviewRef.current = previewUrl;
      setSecondaryPreview(previewUrl);
      setSecondaryBlob(blob);
      setReviewSide("primary");
      setState("review");
      setMessage("Pair ready");
      stopCamera();
      return;
    }

    clearPreview(singlePreviewRef, setSinglePreview);
    singlePreviewRef.current = previewUrl;
    setSinglePreview(previewUrl);
    setSingleBlob(blob);
    setReviewSide("primary");
    setState("review");
    setMessage("Shot ready");
    stopCamera();
  }

  async function send() {
    setState("sending");
    setMessage("Sending");
    const form = new FormData();

    if (mode === "double") {
      if (!primaryBlob || !secondaryBlob) {
        setState("review");
        setMessage("The pair is incomplete.");
        return;
      }
      form.append("photoRear", primaryBlob, `saudade-rear-${Date.now()}.jpg`);
      form.append("photoFront", secondaryBlob, `saudade-front-${Date.now()}.jpg`);
    } else {
      if (!singleBlob) {
        setState("review");
        setMessage("The shot is missing.");
        return;
      }
      form.append("photo", singleBlob, `saudade-${Date.now()}.jpg`);
      form.append("captureSide", mode);
    }

    form.append("captureSource", "camera-canvas");
    form.append("captureMode", mode);
    form.append("captureTimestamp", new Date().toISOString());

    const response = await fetch(`${API_URL}/api/capture/${publicToken}/upload`, {
      method: "POST",
      body: form
    });

    if (response.ok) {
      setState("success");
      setMessage("Sent.");
      stopCamera();
      clearAllPreviews();
      return;
    }

    const body = await response.json().catch(() => ({}));
    setState("review");
    setMessage(body.message ?? "Upload failed. Try again in a moment.");
  }

  function retake() {
    clearAllPreviews();
    setStage(mode === "double" ? "primary" : "single");
    setReviewSide("primary");
    setMessage("Opening camera");
    void configureMode(mode).catch(() => {
      setState("error");
      setMessage("Camera could not be reopened.");
    });
  }

  const modeButtonClass = (value: CaptureMode) =>
    `modeButton ${mode === value ? "modeButtonActive" : ""}`;

  const reviewPrimary = mode === "double" ? primaryPreview : singlePreview;
  const reviewSecondary = mode === "double" ? secondaryPreview : null;
  const reviewPrimaryLabel = mode === "back" ? "Back" : "Rear";
  const reviewSecondaryLabel = "Front";

  return (
    <main className="shell">
      <section className="brand">
        <div className="brandIdentity">
          <img className="brandIcon" src="/logo.png" alt="" aria-hidden="true" />
          <p>Saudade</p>
        </div>
        <span>wear the signal</span>
      </section>

      <div className="modeSwitch" role="tablist" aria-label="Capture mode">
        <button type="button" className={modeButtonClass("double")} onClick={() => void configureMode("double")}>Double memories</button>
        <button type="button" className={modeButtonClass("front")} onClick={() => void configureMode("front")}>Front</button>
        <button type="button" className={modeButtonClass("back")} onClick={() => void configureMode("back")}>Back</button>
      </div>

      <section className="cameraPanel" aria-live="polite">
        {(state === "loading" || state === "camera") && (
          <video ref={videoRef} className={`camera ${cameraFacing === "user" ? "frontCamera" : ""}`} playsInline muted />
        )}

        {state === "review" ? (
          reviewSecondary && reviewPrimary ? (
            <button
              type="button"
              className="stackStage"
              onClick={() => setReviewSide((current) => (current === "primary" ? "secondary" : "primary"))}
            >
              <div className={`stackLayer stackPrimary ${reviewSide === "primary" ? "stackActive" : "stackInactive"}`}>
                <img className="stackImage" src={reviewPrimary} alt="Primary preview" />
                <span className="stackBadge">{reviewPrimaryLabel}</span>
              </div>
              <div className={`stackLayer stackSecondary ${reviewSide === "secondary" ? "stackActive" : "stackInactive"}`}>
                <img className="stackImage" src={reviewSecondary} alt="Secondary preview" />
                <span className="stackBadge">{reviewSecondaryLabel}</span>
              </div>
            </button>
          ) : (
            <button
              type="button"
              className="stackStage"
              onClick={() => setReviewSide("primary")}
            >
              <div className="stackLayer stackSolo stackActive">
                <img className="stackImage" src={reviewPrimary ?? ""} alt="Captured preview" />
                <span className="stackBadge">{mode === "front" ? "Front" : "Back"}</span>
              </div>
            </button>
          )
        ) : null}

        {state === "success" && <div className="successMark">Sent</div>}
        {state === "error" && <div className="errorMark">{message}</div>}
      </section>

      {message && state !== "error" ? <p className="status">{message}</p> : null}

      <div className="actions">
        {state === "camera" && (
          <button className="primary" onClick={capture} disabled={!cameraReady}>
            {mode === "double" ? (stage === "primary" ? "Capture rear" : "Capture front") : "Capture"}
          </button>
        )}
        {state === "review" && (
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

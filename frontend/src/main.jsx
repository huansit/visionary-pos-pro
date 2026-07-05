import React from "react";
import { createRoot } from "react-dom/client";
import VisionPOS from "./VisionaryPOS.jsx";

class VisionPOSErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("VisionPOS frontend crash", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#0b1117",
          color: "#f8fafc",
          fontFamily: "Inter, system-ui, sans-serif",
          padding: 24,
        }}>
          <div style={{
            width: "min(560px, 100%)",
            border: "1px solid rgba(148,163,184,.28)",
            borderRadius: 18,
            background: "#111827",
            padding: 28,
            boxShadow: "0 24px 80px rgba(0,0,0,.35)",
          }}>
            <div style={{ color: "#60a5fa", fontSize: 13, fontWeight: 800, letterSpacing: 2, textTransform: "uppercase" }}>VisionPOS recovered a screen error</div>
            <h1 style={{ margin: "12px 0 8px", fontSize: 28 }}>The page could not finish loading.</h1>
            <p style={{ color: "#94a3b8", lineHeight: 1.55 }}>Reload the page. If it happens again, open the browser console and copy the error below.</p>
            <pre style={{
              whiteSpace: "pre-wrap",
              color: "#fecaca",
              background: "rgba(127,29,29,.22)",
              border: "1px solid rgba(248,113,113,.35)",
              borderRadius: 12,
              padding: 14,
              marginTop: 16,
              fontSize: 13,
            }}>{String(this.state.error?.message || this.state.error || "Unknown frontend error")}</pre>
            <button
              onClick={() => window.location.reload()}
              style={{
                width: "100%",
                marginTop: 18,
                border: 0,
                borderRadius: 12,
                padding: "14px 18px",
                color: "#07111f",
                background: "#67e8f9",
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              Reload VisionPOS
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <VisionPOSErrorBoundary>
      <VisionPOS />
    </VisionPOSErrorBoundary>
  </React.StrictMode>
);

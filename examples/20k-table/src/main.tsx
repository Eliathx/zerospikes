import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

if (import.meta.env.VITE_SLOWDOWN) {
  const { installSlowdown } = await import("./slowdown");
  installSlowdown(JSON.parse(import.meta.env.VITE_SLOWDOWN));
}

createRoot(document.getElementById("root")!).render(<App />);

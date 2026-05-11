import { createRoot } from "react-dom/client";
import { setBaseUrl } from "@workspace/api-client-react";
import App from "./App";
import "./index.css";

// In production the dashboard and api-server are deployed as separate Vercel projects.
// Point the API client at the api-server's origin via VITE_API_URL. In dev, leave unset
// to use Vite's /api proxy to localhost:3000.
const apiBaseUrl = import.meta.env["VITE_API_URL"];
if (apiBaseUrl) {
  setBaseUrl(apiBaseUrl);
}

createRoot(document.getElementById("root")!).render(<App />);

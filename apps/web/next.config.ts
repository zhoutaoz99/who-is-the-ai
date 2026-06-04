import os from "os";
import path from "path";
import type { NextConfig } from "next";

function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const config of iface ?? []) {
      if (config.family === "IPv4" && !config.internal) {
        return config.address;
      }
    }
  }
  return "localhost";
}

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    root: path.resolve(__dirname, "../.."),
  },
  ...(process.env.NODE_ENV === "development" && {
    allowedDevOrigins: [getLocalIp()],
  }),
};

export default nextConfig;

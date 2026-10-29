// A port the OS reports as free. Test files run in parallel, so random ports
// from fixed ranges can collide; asking the OS cannot.
import net from "node:net";

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

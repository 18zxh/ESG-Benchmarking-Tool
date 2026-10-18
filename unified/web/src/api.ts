export async function api<T = any>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(
    path.startsWith("/api/") ? path : "/api/workspace" + path,
    data === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
  );
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      typeof value.error === "string"
        ? value.error
        : typeof value.error?.message === "string"
          ? value.error.message
          : "本机操作未完成，请重试。",
    );
  return value;
}
export const originalUrl = (id: string) =>
  "/api/workspace/documents/" + encodeURIComponent(id);
export async function upload(file: File) {
  const response = await fetch("/api/workspace/documents", {
    method: "POST",
    headers: {
      "Content-Type": "application/pdf",
      "X-File-Name": encodeURIComponent(file.name),
    },
    body: file,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
}
export function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

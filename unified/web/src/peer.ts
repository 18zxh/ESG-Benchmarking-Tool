import type { Method, Result } from "./types";
export function peerChecks(method: Method | undefined, results: Result[]):{key:string;title:string}[] {
  const payload = method?.payload;
  if (payload?.framework?.levels && payload?.rules?.topics)
    return payload.rules.topics.flatMap((t: any) =>
      payload.framework.levels.flatMap((l: any) =>
        l.checks.map((c: any) => ({
          key: t.id + "::" + c.id,
          title: t.name + " / " + c.name,
        })),
      ),
    );
  return [
    ...new Set(results.map((r) => r.id.substring(r.id.indexOf("::") + 2))),
  ].map((key) => ({
    key,
    title: results.find((r) => r.id.endsWith("::" + key))?.title || key,
  }));
}

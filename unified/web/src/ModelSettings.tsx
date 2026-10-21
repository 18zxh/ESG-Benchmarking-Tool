import { useState } from "react";
import { api } from "./api";
import { Button, Field } from "./ui";
import type { Common } from "./types";

type Service = "glm" | "cpa";
const defaults = {
  glm: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-5.3-flash",
  },
  cpa: { baseUrl: "http://127.0.0.1:8317/v1", model: "gpt-6-luna" },
};
export default function ModelSettings({ boot, refresh, report, fail }: Common) {
  const current = boot.providers[0];
  const initial = (current?.service || "glm") as Service;
  const [service, setService] = useState<Service>(initial);
  const [baseUrl, setBaseUrl] = useState(
    current?.baseUrl || defaults[initial].baseUrl,
  );
  const [model, setModel] = useState(current?.model || defaults[initial].model);
  const [effort, setEffort] = useState(current?.reasoningEffort || "medium");
  const [readingEffort, setReadingEffort] = useState(current?.readingEffort || "low");
  const [key, setKey] = useState("");
  const [useLocalKey, setUseLocalKey] = useState(
    Boolean(boot.modelConfig?.cpaLocalKeyAvailable),
  );
  const [busy, setBusy] = useState("");
  const choose = (next: Service) => {
    setService(next);
    setBaseUrl(
      current?.service === next ? current.baseUrl! : defaults[next].baseUrl,
    );
    setModel(current?.service === next ? current.model : defaults[next].model);
    setEffort(
      current?.service === next ? current.reasoningEffort || "medium" : "medium",
    );
    setReadingEffort(current?.service === next ? current.readingEffort || "low" : "low");
    setKey("");
  };
  const matches =
    current &&
    (current.service || "glm") === service &&
    current.baseUrl === baseUrl.replace(/\/$/, "") &&
    current.model === model &&
    (service !== "cpa" || (current.reasoningEffort === effort && current.readingEffort === readingEffort)) &&
    !key;
  return (
    <section className="section">
      <h2>共享模型连接</h2>
      <p>
        {current
          ? `当前使用 ${current.name || current.service?.toUpperCase() || "GLM"} · ${current.model}${current.reasoningEffort ? ` · 原文读取 ${current.readingEffort || "low"} / 评估 ${current.reasoningEffort}` : ""}`
          : "尚未连接模型。"}
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy("connect");
          try {
            await api("/api/v1/providers", {
              service,
              baseUrl,
              model,
              apiKey: key,
              reasoningEffort: service === "cpa" ? effort : undefined,
              readingEffort: service === "cpa" ? readingEffort : undefined,
              useLocalKey: service === "cpa" && useLocalKey,
            });
            setKey("");
            await refresh();
            report("连接配置已应用到所有工作台。可先测试连接，再开始评估。");
          } catch (error) {
            fail(error);
          } finally {
            setBusy("");
          }
        }}
      >
        <fieldset disabled={Boolean(busy)} className="model-settings-fields">
          <div className="form-grid">
            <Field label="服务类型">
              <select
                value={service}
                onChange={(e) => choose(e.target.value as Service)}
              >
                <option value="glm">GLM · 官方接口</option>
                <option value="cpa">CPA · 本机代理</option>
              </select>
            </Field>
            <Field
              label={
                service === "cpa" ? "CPA 本机接口地址" : "GLM 官方接口地址"
              }
            >
              <input
                type="url"
                required
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </Field>
            <Field label="模型">
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {service === "cpa" ? (
                  <option value="gpt-6-luna">GPT-6 Luna</option>
                ) : (
                  <>
                    <option value="glm-5.3-flash">GLM 5.3 Flash</option>
                    <option value="glm-5.3-flashx">GLM 5.3 FlashX</option>
                  </>
                )}
              </select>
            </Field>
            {service === "cpa" ? (
              <>
              <Field label="原文读取推理强度">
                <select value={readingEffort} onChange={(e) => setReadingEffort(e.target.value)}>
                  {["none", "low", "medium", "high", "xhigh", "max"].map((value) => (
                    <option key={value} value={value}>{value}{value === "low" ? "（推荐）" : ""}</option>
                  ))}
                </select>
              </Field>
              <Field label="评估推理强度">
                <select
                  value={effort}
                  onChange={(e) => setEffort(e.target.value)}
                >
                  {["none", "low", "medium", "high", "xhigh", "max"].map(
                    (value) => (
                      <option key={value} value={value}>
                        {value}
                        {value === "medium" ? "（推荐）" : ""}
                      </option>
                    ),
                  )}
                </select>
              </Field>
              </>
            ) : null}
            <Field label="应用 API Key（仅进程内存）">
              <input
                type="password"
                autoComplete="off"
                disabled={service === "cpa" && useLocalKey}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={
                  service === "cpa" && useLocalKey
                    ? "由服务读取本机已配置密钥"
                    : "填写密钥；本次运行已登记同一连接时可留空"
                }
              />
            </Field>
          </div>
          {service === "cpa" ? (
            <>
              <label className="check">
                <input
                  type="checkbox"
                  checked={useLocalKey}
                  onChange={(e) => {
                    setUseLocalKey(e.target.checked);
                    setKey("");
                  }}
                />
                使用本机已配置的 CPA 应用密钥
              </label>
              <p className="muted">
                原文读取默认 low，评估默认 medium；提高推理强度通常需要更长时间。
                MSCI 全文读取每批最多 3 页，同时最多处理 2 批。
              </p>
              <p className="muted">
                填写应用 API Key，不使用管理网页密钥。CPA
                使用已授权账号的可用额度。
              </p>
            </>
          ) : null}
          <div className="actions">
            <Button type="submit">
              {busy === "connect" ? "正在应用…" : "应用连接配置"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!matches || Boolean(busy)}
              onClick={async () => {
                if (busy) return;
                setBusy("test");
                try {
                  const result = await api<{ model: string }>(
                    "/api/v1/providers/check",
                    {},
                  );
                  report(
                    `${result.model} 连接测试成功。此次只发送简短测试内容。`,
                  );
                } catch (error) {
                  fail(error);
                } finally {
                  setBusy("");
                }
              }}
            >
              {busy === "test" ? "正在测试…" : "测试当前连接"}
            </Button>
          </div>
        </fieldset>
      </form>
      <p className="muted">
        密钥不进入项目、备份或导出，重启工作台后需重新连接。AI 评估会将所选 PDF
        副本、方法与证据发送至所选服务。
      </p>
    </section>
  );
}

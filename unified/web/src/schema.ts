import type { RJSFSchema } from "@rjsf/utils";
import type { Bootstrap, ModuleId } from "./types";
export function scopeSchema(module: ModuleId, boot: Bootstrap): RJSFSchema {
  const properties: Record<string, any> = {};
  const required: string[] = [];
  if (module === "csa") {
    properties.industry = {
      type: "string",
      title: "官方 CSA 行业",
      oneOf: boot.industries.map((i) => ({
        const: i.code,
        title: i.code + " · " + i.name,
      })),
    };
    properties.industryBasis = { type: "string", title: "行业确认依据" };
    properties.listed = {
      type: "string",
      title: "上市身份",
      oneOf: [
        { const: "unknown", title: "尚待确认" },
        { const: "listed", title: "上市公司" },
        { const: "nonlisted", title: "非上市公司" },
      ],
    };
    required.push("industry", "industryBasis");
  }
  if (module === "msci") {
    properties.assessmentScope = {
      type: "string",
      title: "客户评级资料、行业及方法适用范围",
    };
    properties.acknowledged = {
      type: "boolean",
      title: "已核对客户评级资料与方法适用性",
    };
  }
  if (module === "mainland") {
    properties.exchange = {
      type: "string",
      title: "交易所",
      oneOf: [
        { const: "sh", title: "上海证券交易所" },
        { const: "sz", title: "深圳证券交易所" },
        { const: "bj", title: "北京证券交易所" },
      ],
    };
    properties.board = {
      type: "string",
      title: "板块",
      enum: ["主板", "科创板", "创业板", "北交所"],
    };
    properties.industry = { type: "string", title: "所属行业（选填）" };
    required.push("exchange");
  }
  if (module === "hkex") {
    properties.issuerCategory = {
      type: "string",
      title: "发行人类别",
      oneOf: [
        { const: "mainboard", title: "其他主板发行人" },
        { const: "largecap", title: "恒生综合大型股指数成分股" },
        { const: "gem", title: "GEM发行人" },
      ],
    };
    properties.fiscalYearStart = {
      type: "string",
      title: "财政年度开始日期",
      format: "date",
    };
    required.push("issuerCategory", "fiscalYearStart");
  }
  if (module === "benchmark")
    properties.industry = { type: "string", title: "对标行业（选填）" };
  return { type: "object", properties, required };
}
export const metadataSchema: RJSFSchema = {
  type: "object",
  required: ["version", "sourceNote"],
  properties: {
    version: { type: "string", title: "方法版本" },
    sourceNote: { type: "string", title: "官方来源、获取日期与变更说明" },
  },
};

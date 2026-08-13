import type { EtfCreatorCriteria } from "./etf-creator";
import type { EtfShareClass, Holding } from "./etf";
import type { PortfolioRecord } from "./portfolio";

export interface LocalCustomEtfDetail {
  kind: "custom";
  etf: EtfShareClass;
  sourceEtfId: string;
  criteria: EtfCreatorCriteria;
  selectedSecurityIds: string[];
  holdings: Holding[];
  editableDescription: string;
}

export interface LocalPortfolioEtfDetail {
  kind: "portfolio";
  etf: EtfShareClass;
  portfolio: PortfolioRecord;
  editableDescription: string;
}

export type LocalEtfDetail =
  | LocalCustomEtfDetail
  | LocalPortfolioEtfDetail;

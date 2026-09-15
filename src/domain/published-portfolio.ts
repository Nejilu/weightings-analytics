export interface PublishedPortfolio {
  ticker: string;
  name: string;
  updatedAt: string;
  totalMarketValueUsd: number | null;
  items: Array<{
    ticker: string;
    name: string;
    quantity: number | null;
    currentValueUsd: number | null;
    allocationWeight: number;
  }>;
  cash: Array<{
    currency: string;
    amount: number;
    valueUsd: number | null;
    weight: number | null;
  }>;
}

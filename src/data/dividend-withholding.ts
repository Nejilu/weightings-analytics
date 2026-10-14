import type { DividendSettings } from "@/domain/dividends";

export interface CountryDividendRate { country: string; rate: number | null; note: string; sourceUrl: string | null; requiresOverride?: boolean }
const rate = (country: string, value: number, note: string, sourceUrl: string, requiresOverride = false): CountryDividendRate => ({ country, rate: value, note, sourceUrl, requiresOverride });

// Ordinary cash dividends to non-resident individuals, before treaty relief.
// These are estimates, not the investor's final domestic tax liability.
export const COUNTRY_DIVIDEND_RATES: readonly CountryDividendRate[] = [
  rate("United States", 30, "General non-resident rate. Eligible treaty residents may obtain a reduced rate (often 15%) with a valid W-8BEN. Special distributions can differ.", "https://www.irs.gov/individuals/international-taxpayers/nra-withholding"),
  rate("Taiwan", 21, "General non-resident dividend rate. ADR depositary fees may reduce the cash received separately.", "https://www.etax.nat.gov.tw/etwmain/en/announcement/alien-individual-income-tax/instructions"),
  rate("Korea (South)", 22, "General non-resident rate including local tax, before treaty relief. ADR/GDR fees are separate.", "https://www.mkif.com/en/investor-centre/faqs.html"),
  rate("Japan", 15.315, "Listed shares held by a non-resident individual owning less than 3%, before treaty relief. Larger stakes and unlisted shares differ.", "https://www.nta.go.jp/publication/pamph/gensen/shikata2018/pdf/withholdingtaxguide2018.pdf"),
  rate("China", 20, "Individual base rate. H shares, Stock Connect, offshore domiciles and treaty relief differ. Configure the rate for the actual security.", "https://www.chinatax.gov.cn/eng/c102962/c102967/c102997/c103004/c5245849/content.html", true),
  rate("Canada", 25, "General Part XIII rate before treaty relief.", "https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/t4058/non-residents-income-tax.html"),
  rate("United Kingdom", 0, "Ordinary company dividends. REIT property income distributions can have withholding.", "https://www.business.gov.uk/invest-in-uk/investment/uk-tax-and-incentives/"),
  rate("France", 12.8, "Identified non-resident individuals, before treaty relief. Brokers unable to identify the beneficiary may withhold a higher rate.", "https://www.impots.gouv.fr/international-particulier/mes-dividendes"),
  rate("Germany", 26.375, "25% capital income tax plus 5.5% solidarity surcharge on that tax, before treaty relief.", "https://bzst.de/EN/Businesses/businesses_node.html"),
  rate("Switzerland", 35, "Initial withholding before treaty relief or subsequent refunds.", "https://www.estv.admin.ch/en/anticipatory-tax/foreign-persons/reduction-at-source.html"),
  rate("Sweden", 30, "General non-resident dividend rate before treaty relief.", "https://www.skatteverket.se/servicelankar/otherlanguages/inenglish/individualsandemployees/declaringtaxesforindividuals/swedishwithholdingtaxondividends.106.7be5268414bea064694d3e5.html"),
  rate("Netherlands", 15, "General dividend withholding rate before relief.", "https://www.belastingdienst.nl/wps/wcm/connect/bldcontenten/belastingdienst/business/profit/dividend-tax/dividend-tax-if-you-receive-dividend/"),
  rate("Ireland", 25, "Ordinary company dividends. Qualifying non-residents can claim exemptions; this is not an Irish ETF rule.", "https://www.revenue.ie/en/companies-and-charities/dividend-withholding-tax/index.aspx"),
  rate("Hong Kong", 0, "Hong Kong company dividends. A company domiciled in mainland China can follow different rules.", "https://www.ird.gov.hk/eng/pdf/dipn44.pdf"),
  rate("Singapore", 0, "Ordinary dividends under the one-tier corporate tax system. REIT distributions can differ.", "https://www.iras.gov.sg/taxes/individual-income-tax/basics-of-individual-income-tax/what-is-taxable-what-is-not/dividends"),
  rate("Australia", 30, "30% for unfranked dividends; franked portions can be exempt. Set a country or stock override before estimating net income.", "https://www.ato.gov.au/forms-and-instructions/you-and-your-shares-2020/dividends-paid-or-credited-to-non-resident-shareholders", true),
  rate("India", 20, "Base rate only: surcharge and cess can apply. Set your actual rate before estimating net income.", "https://www.incometaxindia.gov.in/w/taxation-of-dividend-and-interest", true),
  rate("Brazil", 10, "Non-resident dividend withholding from January 2026. Transitional distributions of pre-2026 profits can be exempt; interest on equity follows different rules. Confirm the actual payment rate.", "https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2025/dezembro/receita-federal-lanca-perguntas-e-respostas-sobre-tributacao-de-altas-rendas-consideracoes-sobre-lucros-e-dividendos/manual_padrao_rfb_per_tributacao_sutri_v2.pdf", true),
  rate("Norway", 25, "General initial withholding before treaty relief.", "https://www.skatteetaten.no/en/person/taxes/get-the-taxes-right/shares-and-securities/about-shares-and-securities/reduced-withholding-tax-on-dividends/"),
  rate("Spain", 19, "General non-resident dividend rate before treaty relief.", "https://sede.agenciatributaria.gob.es/Sede/en_gb/ayuda/manuales-videos-folletos/manuales-practicos/manual-tributacion-no-residentes/capitulo-03-tributacion-rentas-comunes-nr/otros-rendimientos/rendimientos-capital-mobiliario.html"),
  rate("South Africa", 20, "General dividend withholding before exemptions or treaty relief.", "https://www.sars.gov.za/types-of-tax/dividends-tax/"),
];

export function countryDividendRule(country: string): CountryDividendRate {
  const aliases: Record<string, string> = { USA: "United States", US: "United States", UK: "United Kingdom", "South Korea": "Korea (South)" };
  const name = Object.hasOwn(aliases, country) ? aliases[country] : country;
  return COUNTRY_DIVIDEND_RATES.find((rule) => rule.country.toLowerCase() === name.toLowerCase())
    ?? { country, rate: null, note: "No verified single default rate. Configure the rate shown on your broker statement.", sourceUrl: null };
}

export function dividendWithholdingRate(securityId: string, country: string, settings: DividendSettings): number | null {
  const rule = countryDividendRule(country);
  return (Object.hasOwn(settings.securityRates, securityId) ? settings.securityRates[securityId] : undefined)
    ?? (Object.hasOwn(settings.countryRates, country) ? settings.countryRates[country] : undefined) ?? (rule.requiresOverride ? null : rule.rate);
}

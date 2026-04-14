require("dotenv").config();

const { renderTemplate } = require("../dist/documents/templateRenderer.js");

async function main() {
  const common = {
    CONTRACT_NO: "IPM_ARC_GEN_202604_901",
    CONTRACT_DATE_FORMATTED: "April 6, 2026",
    COUNTERPARTY_NAME: "Northwind Games GmbH",
    COUNTERPARTY_ADDRESS: "Friedrichstrasse 120, 10117 Berlin, Germany",
    COUNTERPARTY_REPRESENTATIVE: "Anna Keller, Managing Director",
    COUNTERPARTY_NOTICE_CONTACT: "Anna Keller / Managing Director / legal@northwind.example",
    PARTY_A_NAME: "Arclight Co., Ltd.",
    PARTY_A_ADDRESS: "1-2 Kanda Ogawamachi, Chiyoda-ku, Tokyo 101-0052 Japan",
    PARTY_A_REP: "Masayuki Aoyagi, Representative Director",
    PARTY_A_NOTICE_CONTACT: "Legal Department / legal@arclight.co.jp",
    ORIGINAL_WORK: "Sky Harbor",
    TERRITORY: "Germany / Austria / Switzerland",
    LANGUAGE_SCOPE: "German",
    EXCLUSIVITY: "Exclusive",
    INITIAL_TERM: "3 years from the first commercial release",
    RENEWAL_TERMS: "Automatic renewal for successive 2-year terms unless either party gives notice",
    NON_RENEWAL_NOTICE: "3 months before expiry of the then-current term",
    CURRENCY: "EUR",
    SELL_OFF_PERIOD: "180 days after expiration or termination",
    GOVERNING_LAW: "Laws of Japan",
    DISPUTE_RESOLUTION: "Tokyo District Court / JCAA Arbitration in Tokyo if cross-border enforcement requires",
    AGREEMENT_LANGUAGE: "English prevails",
    JURISDICTION: "Tokyo District Court",
    SCHEDULE_1_SUMMARY: [
      "Royalty: 12% of Net Sales",
      "Minimum Guarantee: EUR 35,000 per contract year",
      "Advance: EUR 10,000 recoupable",
      "Accounting / reporting: quarterly, report within 30 days, payment within 15 days",
      "First print run: 5,000 units / target release: September 1, 2026",
      "Complimentary copies: 15 copies / credit wording as approved by Licensor",
    ].join("\n"),
    SCHEDULE_1_SPECIAL_PROVISIONS: [
      "Mandatory DACH consumer law and product liability rules apply to the minimum non-waivable extent.",
      "Royalty payments are exclusive of VAT, with reverse-charge treatment where legally available.",
      "No local copyright registration is currently required, but parties will cooperate if later required.",
      "To the extent moral rights are non-waivable, Licensee will follow Licensor brand-integrity instructions.",
    ].join("\n"),
    SCHEDULE_2_SUMMARY: [
      "Base game SKU SH-DE-001 / Unit Price EUR 8.60 / MOQ 1,500 units",
      "MPR: Year 1 = 8,000 units / Year 2 = 10,000 units / Year 3 onward = 12,000 units",
      "Delivery: DAP Hamburg warehouse - Incoterms 2020",
      "Payment: 30% advance on PO, 70% within 5 business days after shipment",
      "Currency: EUR",
    ].join("\n"),
    SCHEDULE_2_SPECIAL_PROVISIONS: [
      "Licensee acts as importer of record and bears import VAT / customs clearance costs.",
      "Licensee handles destination-country labeling and any mandatory marketplace compliance filings.",
      "Licensee maintains EUR 5,000,000 product liability coverage per claim.",
      "Pre-approved online channels: Amazon.de, Thalia, FantasyWelt, and Licensee-operated web store.",
    ].join("\n"),
    S1_ROYALTY_RATE: "12% of Net Sales",
    S1_MINIMUM_GUARANTEE: "EUR 35,000 per contract year, payable in two equal installments",
    S1_ADVANCE: "EUR 10,000 recoupable against earned royalties",
    S1_ACCOUNTING_PERIOD: "Quarterly",
    S1_PAYMENT_DUE: "Within 15 days after the end of each accounting period and receipt of invoice",
    S1_REPORT_DUE: "Within 30 days after the end of each accounting period",
    S1_FX_CONVERSION: "ECB euro reference rate on the last business day of the reporting quarter",
    S1_FIRST_PRINT_RUN: "5,000 units",
    S1_TARGET_RELEASE_DATE: "September 1, 2026",
    S1_COMPLIMENTARY_COPIES: "15 copies to Licensor, freight collect",
    S1_CREDIT_WORDING: "Original game design by Arclight Co., Ltd. / German edition published by Northwind Games GmbH",
    S1_TERRITORY_JURISDICTION: "Germany / Austria / Switzerland",
    S1_CONSUMER_LAW_CARVEOUT: "Mandatory DACH consumer protection and product liability provisions apply to the minimum extent required by law.",
    S1_VAT_GST_TREATMENT: "Royalty payments are exclusive of VAT; reverse-charge treatment applies where legally available.",
    S1_COPYRIGHT_REGISTRATION: "No local registration currently required; parties will cooperate if a local filing later becomes mandatory.",
    S1_MORAL_RIGHTS: "To the extent non-waivable moral rights apply under German law, Licensee will follow Licensor brand-integrity directions.",
    S1_MANDATORY_DISTRIBUTION_LAW: "Any mandatory distributor protections under applicable local law apply only to the minimum non-waivable extent.",
    S1_ADDITIONAL_TERMS: "Localized FAQ leaflet and tournament kit may be produced only with prior written approval.",
    S2_PRODUCT_PRICE_LIST: "Base game SKU SH-DE-001 / Unit Price EUR 8.60 / MOQ 1,500 / Unit boxed copy / Remarks: German sticker labeling by Licensee",
    S2_MPR_YEAR1: "8,000 units or EUR 68,800 equivalent",
    S2_MPR_YEAR2: "10,000 units or EUR 86,000 equivalent",
    S2_MPR_YEAR3: "12,000 units or as otherwise agreed in annual business plan",
    S2_INCOTERMS_DELIVERY: "DAP Hamburg central warehouse - Incoterms 2020",
    S2_ARRIVAL_POINT: "Northwind Games GmbH distribution warehouse, Hamburg, Germany",
    S2_PAYMENT_ADVANCE: "30% of purchase order total payable upon PO placement",
    S2_PAYMENT_BALANCE: "70% within 5 business days after confirmed shipment date",
    S2_PAYMENT_CURRENCY: "EUR",
    S2_TERRITORY_JURISDICTION: "Germany / Austria / Switzerland",
    S2_IMPORT_CUSTOMS_ALLOCATION: "Licensee bears import VAT and customs clearance costs; parties will cooperate on any available duty relief.",
    S2_CONSUMER_PRODUCT_SAFETY: "Licensee will complete German-market labeling, WEEE/BattG review if applicable, and any importer registration required for resale.",
    S2_DISTRIBUTION_LAW_PROTECTIONS: "Any mandatory commercial distributor protections in the Territory apply only to the minimum non-waivable extent.",
    S2_VAT_GST_SUPPLY: "Quoted supply prices are net of import VAT; destination-country VAT is handled by Licensee as importer of record.",
    S2_PRODUCT_LIABILITY_INSURANCE: "Licensee maintains EUR 5,000,000 product liability coverage per claim during the term and 3 years thereafter.",
    S2_MARKETPLACE_ONLINE_SALES: "Pre-approved online channels: Amazon.de, Thalia, FantasyWelt, and Licensee-operated web store.",
    S2_ADDITIONAL_TERMS: "No relabeling or bundle repackaging without Licensor's prior written approval.",
  };

  const licenseOut = await renderTemplate({
    templateKey: "ip_overseas_master",
    uploadToDrive: false,
    outputBasename: "SAMPLE_IGLA_license_out",
    variables: {
      ...common,
      DEAL_STRUCTURE: "license_out",
      APPLICABLE_SUPPLEMENTAL_TERMS: "Supplemental Terms – License-Out",
    },
  });

  const productOut = await renderTemplate({
    templateKey: "ip_overseas_master",
    uploadToDrive: false,
    outputBasename: "SAMPLE_IGLA_product_out",
    variables: {
      ...common,
      CONTRACT_NO: "IPM_ARC_GEN_202604_902",
      DEAL_STRUCTURE: "product_out",
      APPLICABLE_SUPPLEMENTAL_TERMS: "Supplemental Terms – Product-Out",
    },
  });

  console.log("Generated:");
  console.log(licenseOut.localPath);
  console.log(productOut.localPath);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

// BODY4AI demo catalog. memberPrice is the "restricted content": it is only
// returned through the WebMCP tools, which only admitted members can reach.
export const PRODUCTS = Object.freeze([
  {
    id: "b4a-001",
    name: "Posture Lab Chair",
    category: "chairs",
    price: 1295,
    memberPrice: 995,
    blurb: "Adjustable lumbar support for long agent-assisted work sessions.",
  },
  {
    id: "b4a-002",
    name: "Standing Desk Frame",
    category: "desks",
    price: 799,
    memberPrice: 649,
    blurb: "Dual-motor frame with four memory heights.",
  },
  {
    id: "b4a-003",
    name: "Monitor Arm Duo",
    category: "accessories",
    price: 249,
    memberPrice: 199,
    blurb: "Gas-spring arm for two displays.",
  },
]);

export function searchCatalog({ query = "", category } = {}) {
  const needle = String(query).trim().toLowerCase();
  return PRODUCTS.filter(
    (product) =>
      (!category || product.category === category) &&
      (!needle ||
        `${product.name} ${product.category} ${product.blurb}`
          .toLowerCase()
          .includes(needle)),
  ).map(({ id, name, category: kind, price, memberPrice }) => ({
    id,
    name,
    category: kind,
    price,
    memberPrice,
  }));
}

export function getProduct(id) {
  return PRODUCTS.find((product) => product.id === id) ?? null;
}

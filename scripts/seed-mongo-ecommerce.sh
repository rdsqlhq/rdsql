#!/usr/bin/env bash
# Seeds a realistic "ecommerce" database into the MongoDB test container
# (docker-compose.yml's `mongo` service) for manually exercising rdSQL
# Desktop's Mongo document browser / ERD-less schema tree against something
# more interesting than a single collection.
#
# Unlike scripts/test-mongo-docker.sh (which seeds a throwaway fixture and
# runs the ignored Rust integration tests), this script is for manual UI
# testing only — it does not run cargo test.
#
# Usage:
#   scripts/seed-mongo-ecommerce.sh          # up, seed (container stays up)
#   scripts/seed-mongo-ecommerce.sh --down   # tear down the container and exit
#
# Then in the app: New Connection → MongoDB → host 127.0.0.1, port 27017,
# database "ecommerce", no auth.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "--down" ]]; then
  echo "==> Stopping MongoDB test container"
  docker compose down mongo
  exit 0
fi

echo "==> Starting MongoDB test container (mongo:27017)"
docker compose up -d mongo

wait_healthy() {
  local service="$1" tries=0
  echo "==> Waiting for '$service' to become healthy"
  while true; do
    local cid status
    cid="$(docker compose ps -q "$service")"
    status="$(docker inspect --format='{{.State.Health.Status}}' "$cid" 2>/dev/null || echo "starting")"
    if [[ "$status" == "healthy" ]]; then
      echo "    $service is healthy."
      return 0
    fi
    tries=$((tries + 1))
    if [[ "$tries" -ge 30 ]]; then
      echo "    $service did not become healthy in time (status: $status)." >&2
      docker compose logs "$service" >&2
      exit 1
    fi
    sleep 1
  done
}
wait_healthy mongo

echo "==> Seeding 'ecommerce' database (dropped first, so re-runs are deterministic)"
docker compose exec -T mongo mongosh --quiet ecommerce <<'EOF' > /dev/null
db.dropDatabase();

db.categories.insertMany([
  { _id: "cat_electronics", name: "Electronics", slug: "electronics" },
  { _id: "cat_apparel", name: "Apparel", slug: "apparel" },
  { _id: "cat_home", name: "Home & Kitchen", slug: "home-kitchen" },
  { _id: "cat_books", name: "Books", slug: "books" },
]);

db.products.insertMany([
  { _id: "prod_001", sku: "ELEC-001", name: "Wireless Headphones", category: "cat_electronics", price: 79.99, currency: "USD", stock: 142, tags: ["audio", "bluetooth"], rating: 4.5, createdAt: new Date("2025-01-15") },
  { _id: "prod_002", sku: "ELEC-002", name: "27\" 4K Monitor", category: "cat_electronics", price: 349.00, currency: "USD", stock: 34, tags: ["display", "4k"], rating: 4.7, createdAt: new Date("2025-02-03") },
  { _id: "prod_003", sku: "ELEC-003", name: "USB-C Hub", category: "cat_electronics", price: 24.99, currency: "USD", stock: 310, tags: ["accessory"], rating: 4.1, createdAt: new Date("2025-02-20") },
  { _id: "prod_004", sku: "APRL-001", name: "Cotton T-Shirt", category: "cat_apparel", price: 14.99, currency: "USD", stock: 500, tags: ["clothing", "unisex"], rating: 4.2, createdAt: new Date("2025-01-05") },
  { _id: "prod_005", sku: "APRL-002", name: "Running Shoes", category: "cat_apparel", price: 89.99, currency: "USD", stock: 76, tags: ["footwear", "sport"], rating: 4.6, createdAt: new Date("2025-03-11") },
  { _id: "prod_006", sku: "HOME-001", name: "Stainless Steel Cookware Set", category: "cat_home", price: 129.99, currency: "USD", stock: 45, tags: ["kitchen", "cookware"], rating: 4.4, createdAt: new Date("2025-01-28") },
  { _id: "prod_007", sku: "HOME-002", name: "Robot Vacuum", category: "cat_home", price: 249.00, currency: "USD", stock: 22, tags: ["appliance", "smart-home"], rating: 4.3, createdAt: new Date("2025-03-02") },
  { _id: "prod_008", sku: "BOOK-001", name: "The Pragmatic Programmer", category: "cat_books", price: 39.99, currency: "USD", stock: 88, tags: ["software", "engineering"], rating: 4.8, createdAt: new Date("2024-11-19") },
]);

db.customers.insertMany([
  { _id: "cust_001", name: "Alice Chen", email: "alice.chen@example.com", address: { street: "12 Market St", city: "San Francisco", state: "CA", zip: "94103", country: "US" }, createdAt: new Date("2024-09-12") },
  { _id: "cust_002", name: "Budi Santoso", email: "budi.santoso@example.com", address: { street: "Jl. Sudirman 45", city: "Jakarta", state: "DKI Jakarta", zip: "10220", country: "ID" }, createdAt: new Date("2024-10-01") },
  { _id: "cust_003", name: "Carla Mendes", email: "carla.mendes@example.com", address: { street: "Rua Augusta 200", city: "São Paulo", state: "SP", zip: "01305-000", country: "BR" }, createdAt: new Date("2025-01-22") },
  { _id: "cust_004", name: "David Kim", email: "david.kim@example.com", address: { street: "88 Teheran-ro", city: "Seoul", state: "Gangnam-gu", zip: "06134", country: "KR" }, createdAt: new Date("2025-02-14") },
]);

db.orders.insertMany([
  { _id: "order_1001", customerId: "cust_001", status: "delivered", items: [ { productId: "prod_001", name: "Wireless Headphones", qty: 1, price: 79.99 }, { productId: "prod_003", name: "USB-C Hub", qty: 2, price: 24.99 } ], total: 129.97, createdAt: new Date("2025-03-01"), shippedAt: new Date("2025-03-02"), deliveredAt: new Date("2025-03-05") },
  { _id: "order_1002", customerId: "cust_002", status: "shipped", items: [ { productId: "prod_002", name: "27\" 4K Monitor", qty: 1, price: 349.00 } ], total: 349.00, createdAt: new Date("2025-03-10"), shippedAt: new Date("2025-03-11") },
  { _id: "order_1003", customerId: "cust_003", status: "processing", items: [ { productId: "prod_006", name: "Stainless Steel Cookware Set", qty: 1, price: 129.99 }, { productId: "prod_008", name: "The Pragmatic Programmer", qty: 1, price: 39.99 } ], total: 169.98, createdAt: new Date("2025-03-18") },
  { _id: "order_1004", customerId: "cust_001", status: "delivered", items: [ { productId: "prod_005", name: "Running Shoes", qty: 1, price: 89.99 } ], total: 89.99, createdAt: new Date("2025-02-01"), shippedAt: new Date("2025-02-02"), deliveredAt: new Date("2025-02-06") },
  { _id: "order_1005", customerId: "cust_004", status: "cancelled", items: [ { productId: "prod_007", name: "Robot Vacuum", qty: 1, price: 249.00 } ], total: 249.00, createdAt: new Date("2025-03-15"), cancelledAt: new Date("2025-03-16") },
]);

db.reviews.insertMany([
  { productId: "prod_001", customerId: "cust_001", rating: 5, comment: "Great sound quality.", createdAt: new Date("2025-03-06") },
  { productId: "prod_005", customerId: "cust_001", rating: 4, comment: "Comfortable but runs small.", createdAt: new Date("2025-02-10") },
  { productId: "prod_008", customerId: "cust_003", rating: 5, comment: "Essential reading.", createdAt: new Date("2025-01-05") },
]);

print("Seeded collections: " + db.getCollectionNames().sort().join(", "));
EOF

echo "==> Done. Collections in 'ecommerce':"
docker compose exec -T mongo mongosh --quiet ecommerce --eval 'db.getCollectionNames().sort().forEach(c => print(" - " + c + " (" + db.getCollection(c).countDocuments() + " docs)"))'

echo
echo "Container is still running — 'mongo' on 127.0.0.1:27017 (no auth)."
echo "In rdSQL Desktop: New Connection → MongoDB → host 127.0.0.1, port 27017, database 'ecommerce'."
echo "Tear down with: scripts/seed-mongo-ecommerce.sh --down"

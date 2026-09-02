AYKIRA FINAL V16

1. Install Node.js LTS.
2. Double-click START_AYKIRA.bat.
3. Open http://localhost:3000/
4. Admin: http://localhost:3000/admin.html
5. Default admin password: AYKIRA@1234 (change AYKIRA_ADMIN_PASSWORD in .env before public hosting).
6. Buyer flow: choose colour/size/quantity -> Add to Cart or Buy Now -> customer details -> PIN verification -> delivery estimate -> Razorpay -> order confirmation.
7. Admin orders are stored in aykira-orders.json. Catalogue is stored in aykira-data.json.
8. The included Razorpay credentials are test credentials. Rotate the exposed test secret and replace with live credentials only on the server before production.
9. For public access from any Android/iPhone/PC, deploy the Node server on HTTPS hosting; localhost is for local testing only.


## Admin
Use `START_ADMIN.bat`. It now starts the AYKIRA server automatically before opening the admin panel, so the panel does not show Failed to fetch when the server is not already running.

## Shipping
Checkout displays FREE SHIPPING / NO DELIVERY CHARGES. Delivery dates remain estimates.


V18: per-design custom pricing. Each design can use default size pricing or its own 18–22, 24–32 and 34–38 prices. Custom prices flow through product cards, detail view, cart, checkout and Razorpay amount.


V21 FIX: launchers stop any previous process listening on port 3000 before starting this build. This prevents an older AYKIRA version from remaining open and causing admin/website data to appear out of sync.

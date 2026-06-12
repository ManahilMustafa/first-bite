// Real E-Street / ValueLink order email, reconstructed as the HTML it ships as.
// Based verbatim on the notification for order 266-03335.
export const ORDER_EMAIL_HTML = `
<html><body>
<p>Dear Vendor</p>
<p>An order for the property at 8140 NIGHTINGALE RD WEEKI WACHEE FL 34613
(Order no. 266-03335) is available, for the following service:</p>
<p>BPO Exterior 5 day. <a href="https://www.valuelinkams.com/order/details?id=266-03335">Click here for details.</a></p>
<table>
<tr><td>Client Name:</td><td>Shellpoint Mortgage Services - Collateral Management</td></tr>
<tr><td>Order Type:</td><td>BPO-VS</td></tr>
<tr><td>Priority:</td><td>Normal</td></tr>
<tr><td>Property Address:</td><td>8140 NIGHTINGALE RD WEEKI WACHEE FL 34613</td></tr>
<tr><td>Property County:</td><td>Hernando</td></tr>
<tr><td>Transaction Type:</td><td>Client Refresh Value</td></tr>
<tr><td>Property Type:</td><td>Single Family Residential</td></tr>
<tr><td>Loan Type:</td><td>Market Value</td></tr>
<tr><td>Borrower(s):</td><td>LAURENE E GORDON</td></tr>
<tr><td>Client File No/Loan Number:</td><td>7092731715</td></tr>
<tr><td>Due Date:</td><td>6/12/2026</td></tr>
<tr><td>Product:</td><td>BPO Exterior 5 day</td></tr>
<tr><td>UAD Report Needed:</td><td>False</td></tr>
<tr><td>AMC Registration Number(FL):</td><td>MC186</td></tr>
<tr><td>Vendor's Fee:</td><td>50.00</td></tr>
<tr><td>Technology Fee:</td><td>4.00</td></tr>
<tr><td>Net Vendor's Fee:</td><td>46.0000</td></tr>
<tr><td>Account Representative 1:</td><td>Amy Shells</td></tr>
</table>
<p>To accept the order, click the Accept/Decline link (below) as soon as possible.
If the order has already been assigned, the link will advise you the order is no longer available.</p>
<p>
  <a href="https://www.valuelinkams.com/order/accept?id=266-03335&amp;tok=abc123XYZ">ACCEPT ORDER</a>
  &nbsp;&nbsp;&nbsp;
  <a href="https://www.valuelinkams.com/order/decline?id=266-03335&amp;tok=abc123XYZ">DECLINE ORDER</a>
</p>
<p>Thank you!</p>
</body></html>`;

export const ORDER_EMAIL_SUBJECT =
  'Accept or decline order [8140 NIGHTINGALE RD WEEKI WACHEE FL 34613 - 266-03335]';

// A plain-text variant (some senders include only text/plain).
export const ORDER_EMAIL_TEXT = `Dear Vendor
An order for the property at 8140 NIGHTINGALE RD WEEKI WACHEE FL 34613 (Order no. 266-03335) is available.
Client Name: Shellpoint Mortgage Services - Collateral Management
Property Address: 8140 NIGHTINGALE RD WEEKI WACHEE FL 34613
Vendor's Fee: 50.00
Net Vendor's Fee: 46.0000
To accept: https://www.valuelinkams.com/order/accept?id=266-03335&tok=abc123XYZ
To decline: https://www.valuelinkams.com/order/decline?id=266-03335&tok=abc123XYZ
Thank you!`;

// A non-order email, to confirm the parser rejects noise.
export const NON_ORDER_EMAIL_HTML = `<html><body>
<p>Your weekly vendor newsletter is here. No action needed.</p>
<a href="https://www.valuelinkams.com/news">Read more</a>
</body></html>`;

## Overview

Astute maintains consignment agreements with multiple different companies which allows us to manage excess inventory on the clients behalf. This entails cataloguing, warehousing, inspecting, marketing, and shipping another companies excess inventory. Within the contractual agreement between Astute and their partner company, the excess is sold with a profit split between the two parties. Furthermore, due to the constantly fluctuating prices of the excess components market, all excess is recorded and marketed a zero cost; then quotes for sales price are given ad hoc and cost is only assigned when a quote is accepted. The goal of these work instructions are to show how to adjust excess costs within our ERP in accordance to our consignment agreements after an item has been sold. A successful use of these work instructions will result in a correct cost being assigned to an excess MPN within our ERP system prior to shipping the item out

## Resources
- Infor 10 Forms
	- Change Warehouse
	- Miscellaneous Issue
	- Miscellaneous Receive
	- helpful: Items
- Cost split rates:
	- W103 - 70% (GE)
	- W106 - 55% (Taxan)
	- W107 - 65% (Spartronics)
## Procedure
1. Receive an RTS (Ready to Ship) Request through email from one of the excess consignment warehouses (W103, W106, W107)
	- An sample request will look like

| COV #, Line #:        | COV0015631, Line # 1           |
| --------------------- | ------------------------------ |
| Customer / Customer # | Astute Electronics Ltd/C001000 |
| MPN:                  | UTG932E                        |
| Quantity to Ship:     | 5                              |
| Location:             | G05A02 - W106                  |
| Price Adjustment:     | .25                            |
| Lot:                  | US240913000004                 |
| Comments:             | Example comment                |

2. Change warehouse
	1. In Infor - open the form "Change Warehouse"
	2. Select the warehouse in that is denoted in the "location" portion of the RTS request and confirm the change by clicking "OK" ![[Pasted image 20240916143304.png]]


3. Write off Zero Cost stock
	1.  In Infor - open the form Miscellaneous Issue
	2.  Enter the MPN from the RTS request in the "Item" field and TAB
	3. Fill out the quantity, location, and lot fields in accordance to the RTS request
	4. In the "Reason" field, select "ESA - Excess Stock Adjustment"
	5. Process
	![[Pasted image 20240916144049.png]]

4. Write the stock onto the system at correct cost
	1. In Infor - open the form Miscellaneous Receipt
	2. Enter the MPN from the RTS request in the "Item" field and TAB
	3. Fill in the quantity and cost in accordance to the RTS request
		- Note: the cost is automatically calculated with Power Automate based on the Warehouse and the initial sales price of the items
	4. Fill in the same location in which the parts were dropped from
	5. A lot will auto-generate, be use the leading two letters of the Infor lot match the same letters as the lot that was dropped in the previous step
	6. In the "Reason" field, select "ESA - Excess Stock Adjustment"
	7. Process
	![[Pasted image 20240916150350.png]]

5. Closing the Loop
	1. Respond to the RTS request email with the new lot number and indicating the cost has been adjusted 

## Notes:

Note: the cost in an RTS request is automatically calculated with Power Automate based on the Warehouse and the initial sales price of the items

The leading letters can be used to denote a Client site in which the parts originated from, this assists in invoicing the correct site. For example:
	- ABC is a company who has 3 sites: XY, UV, RS. 
	- The site is denoted in the infor lot number
		- XY2308220000001 comes from site XY
	- You must be sure the site remains consistent when writing off/on parts in infor


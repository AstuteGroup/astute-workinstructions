## Overview
Within ERP systems, ISEs are responsible to handling specific customers and any associated open orders. In addition to maintaining current customers, they are also responsible for documenting all the work up that is entailed in obtaining a new customer. When an ISE leaves their role with Astute, their customers and open orders needs to be reassigned to a new steward or house.

The purpose of this procedure is to maintain customer care during periods of transitioning roles. The Operations Specialist is tasked with facilitating the hand off of customer codes to new ISE stewards.

## Materials

1. QMS: [Updating Customer Salesperson Information](https://astuteelectronics.sharepoint.com/sites/QUALITYMANAGEMENTSYSTEM/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FQUALITYMANAGEMENTSYSTEM%2FShared%20Documents%2FPurchasing%20%26%20Sales%2FPolicies%20and%20Procedures%2FProcedure%20%2D%20Updating%20Customer%20Salesperson%20Information%2Epdf&parent=%2Fsites%2FQUALITYMANAGEMENTSYSTEM%2FShared%20Documents%2FPurchasing%20%26%20Sales%2FPolicies%20and%20Procedures&p=true&ga=1)
2. Infor:
	1. Customers
	2. Open Orders – Supervisor
	3. Customer Orders
3. Orange Tsunami:
	1. Customers (all)

## Procedure

1. Get notification that ISE is leaving role
2. Pulling Customer List
	1. In Infor, open _Customers_
		1. Navigate to Contacts tab
		2. Search ISE name in the “Internal Salesperson” field, then filter
		3. Export list to Excel
3. Pull Open Orders Book
	1. In Infor, open _Open Orders - Supervisor_
		1. Display>Show Filters
		2. In _Int. Sales Person_ search for the ISE
		3. Send To>Excel
4. MAKE PULL FROM OT (NEEDS COMPLETION)
5. Send Customer Codes and Open Order Book to Sales Managers
	1. Send appropriate sales managers the both excel files
	2. Inquire which customers/orders need to be reassigned to a new ISE steward and which can be allocated to house accounts.
6. Reassign customers and open orders.
	1. After receiving input from sales manager, switch the ISE steward from ISE leaving to the new steward.
		1. In Infor, open _Customers_
			1. Filtering in the same manner as above, select each line and change the Internal Salesperson to the appropriate new steward
			2. Remember to save
		2. In Infor, open _Customer Orders_
			1. Repeat actions of previous step
		3. In OT, open _Customer (all)_
			1. Search name of customer and change ISE field to appropriate new steward

## Overview
Within many excess stock agreements with distributors, there often is a clause that requires Astute to provide a monthly inventory stock report and a list of items sold within the last agreed upon period. This allows take splits to happen accordingly as well as serve as a security exercise. This guide will break down the different consignment reporting requirements between Astute’s excess programs.

## Resources
- Infor 10 Forms
	- Items Lot Report
		- Layouts:
			- W103 (GE Excess)
			- W106 (Taxan Excess)
			- W107 ( Spartonics Excess)
	- Billings - Supervisor
		- Layouts:
			- GE Excess Sales
			- Spartronics Excess Sales
			- Taxan Excess Sales
	- Lots
## Procedure

##### Monthly or Quarterly Reporting?
Depending on the agreement, either monthly or quarterly reporting is required:
- GE and Spartronic are due Quarterly
- Taxan is due monthly

1. In INFOR, Open Items Lot Repot
	1. Layout>Select>{Specific Report You Are Running}
	2. Send To>Excel
	3. FOR SPARTRONICS ONLY
		1. Adding Non-cataloged Inventory:
			1. Open [Spartronics excess](https://astuteelectronics.sharepoint.com/sites/OPERATIONS-USA/Shared%20Documents/Forms/AllItems.aspx?newTargetListUrl=%2Fsites%2FOPERATIONS%2DUSA%2FShared%20Documents&viewpath=%2Fsites%2FOPERATIONS%2DUSA%2FShared%20Documents%2FForms%2FAllItems%2Easpx&id=%2Fsites%2FOPERATIONS%2DUSA%2FShared%20Documents%2FINSPECTIONS%2F1%2DEXCESS&viewid=d1eec53b%2D378f%2D4000%2D9dbf%2D94cb0faab297)
			2. Pull validated catalog lines from the right side, combine with lines that have not been validated
			3. Watertown already entered into infor, Williamsport sent back
	4. SAVE
2. In INFOR, open Billings - Supervisor
	1. Select the dates which you are reporting
		1. Typically the previous month or quarter depending on the partner
			- Spartonics and GE are previous quarter
			- Taxan is previous month
	2. Select the layout for who you wish to report
	3. Export to Excel
3. Formatting Reports
	1. NEEDS TO BE COMPLETED
4. Send reports to respective partners

## Overview
In certain instances, such excess stock programs or strategic buying, material will go through inspections and not have an allocated customer; this material then moves to our stock inventory. The purpose of this guide is to outline the procedure of moving material from Quality Inspection to a stock location—both physically within the warehouses and electronically in an ERP

The overall goal of this procedure is to minimize the number of people handling excess stock to mitigate discrepancies. “The same hands that pull the stock should be the same hands that place the stock”, this way the individual pulling the stock will have a greater degree of familiarity of where it was initially placed.

## Resources
- QMS:
- Infor:
	- QC Supplier Inspect/Disposition
	- Quantity Move

## Procedure
1. Receiving Material that Requires Placement
	1. After material goes through the final steps of an inspection, the Quality Inspection team will place allotted material in the designated excess stock placement area
		1. As of now this is the top shelf of the rack next to the QI table.
	2. Periodically look at this rack; ideally, they will send a notification to the Operations Specialist
2. Find a Physical Location in the Warehouse
	1. Look for a bin that has space, trying to align the correct material type with the bin’s designation (ie REEL7s should go in REEL7 bins)
	2. Consider that it is helpful to keep top shelf bins lighter
3. Move the Material to the New Location
	1. Place Material in bin with any associated paperwork
		1. This may require stapling paperwork to the box or bag, but DO NOT puncture bags
		2. Make sure to keep lots together (ie 1 lot could come in two bags, in that case place both in an additional bag or make 2 labels for them)
4. Move the Material in the ERP
	1. In Infor, open _QC Supplier Inspect/Disposition_
	2. Enter POV number found on the material’s label filter
	3. Check for “Qty Accepted” to match “Quantity Received”
		1. If they match: proceed
		2. If they do not match: “Disposition QC Receiver”
			1. Move to Stock or DIT depending on designation
			2. Process
5. In Infor, open  _Quantity Move_
	1. Enter Item number
	2. Enter quantity
	3. Determine that “From Location” and “From Lot” are correct
	4. In “To Location”, enter the bin location that the material is placed in
	5. Process
6. Move Paperwork into Appropriate Folder
	1. In Sharepoint, open QMS
	2. Search lot number
	3. Move folder from into “Open>Accepted”

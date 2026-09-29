-- Sketch to Pen: drop .sketch files onto the app (or double-click it and pick a file).
on run
	set theFile to choose file with prompt "Choose a Sketch file to convert to pen.dev:"
	convertFiles({theFile})
end run

on open theFiles
	convertFiles(theFiles)
end open

on convertFiles(theFiles)
	if (do shell script "uname -m") is "arm64" then
		set converter to POSIX path of (path to resource "sketch2pen-arm64")
	else
		set converter to POSIX path of (path to resource "sketch2pen-x64")
	end if
	repeat with f in theFiles
		set p to POSIX path of f
		if p does not end with ".sketch" then
			display dialog "“" & p & "” is not a .sketch file." buttons {"OK"} default button 1 with icon caution with title "Sketch to Pen"
		else
			try
				set out to do shell script quoted form of converter & " " & quoted form of p & " 2>&1"
				set reportPath to ""
				repeat with l in paragraphs of out
					if l contains "Report: " then set reportPath to text ((offset of "Report: " in l) + 8) thru -1 of l
				end repeat
				set answer to display dialog out buttons {"Open Report", "Done"} default button 2 with title "Sketch to Pen"
				if button returned of answer is "Open Report" and reportPath is not "" then do shell script "open " & quoted form of reportPath
			on error errMsg
				display dialog "The conversion failed:" & return & return & errMsg buttons {"OK"} default button 1 with icon stop with title "Sketch to Pen"
			end try
		end if
	end repeat
end convertFiles

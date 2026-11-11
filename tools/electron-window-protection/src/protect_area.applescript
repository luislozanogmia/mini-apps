-- Electron Window Protection - AppleScript Component
-- Configurable area protection that keeps other windows out of specified screen regions
-- Usage: osascript protect-area.applescript [x] [y] [width] [height] [excludeApps]

on run argv
    -- Default configuration (can be overridden by command line args)
    set protectionX to 0
    set protectionY to 0  
    set protectionWidth to 320
    set protectionHeight to 1080
    set excludeAppsList to {"SystemUIServer", "Dock", "Finder"}
    
    -- Parse command line arguments
    if (count of argv) ≥ 4 then
        try
            set protectionX to (item 1 of argv) as integer
            set protectionY to (item 2 of argv) as integer
            set protectionWidth to (item 3 of argv) as integer
            set protectionHeight to (item 4 of argv) as integer
        on error
            log "Error: Invalid numeric arguments. Using defaults."
        end try
    end if
    
    -- Parse exclude apps list (comma-separated string)
    if (count of argv) ≥ 5 then
        try
            set excludeAppsString to item 5 of argv
            set AppleScript's text item delimiters to ","
            set excludeAppsList to every text item of excludeAppsString
            set AppleScript's text item delimiters to ""
        on error
            log "Error: Invalid exclude apps format. Using defaults."
        end try
    end if
    
    log "Protection Area: x=" & protectionX & " y=" & protectionY & " w=" & protectionWidth & " h=" & protectionHeight
    log "Excluding apps: " & my listToString(excludeAppsList)
    
    -- Get screen dimensions for boundary calculations
    tell application "System Events"
        set screenBounds to bounds of desktop
        set screenWidth to item 3 of screenBounds
        set screenHeight to item 4 of screenBounds
    end tell
    
    set availableWidth to screenWidth - (protectionX + protectionWidth)
    log "Available width for windows: " & availableWidth
    
    -- Main protection loop
    repeat
        try
            tell application "System Events"
                set allProcesses to every application process whose background only is false
                
                repeat with currentProcess in allProcesses
                    try
                        set processName to name of currentProcess
                        
                        -- Skip excluded applications
                        if not my listContains(excludeAppsList, processName) then
                            set allWindows to every window of currentProcess
                            
                            repeat with currentWindow in allWindows
                                try
                                    set windowPos to position of currentWindow
                                    set windowSize to size of currentWindow
                                    set windowX to item 1 of windowPos
                                    set windowY to item 2 of windowPos
                                    set windowWidth to item 1 of windowSize
                                    set windowHeight to item 2 of windowSize
                                    
                                    -- Check if window overlaps protection area
                                    set windowRight to windowX + windowWidth
                                    set windowBottom to windowY + windowHeight
                                    set protectionRight to protectionX + protectionWidth
                                    set protectionBottom to protectionY + protectionHeight
                                    
                                    set overlapsX to (windowX < protectionRight) and (windowRight > protectionX)
                                    set overlapsY to (windowY < protectionBottom) and (windowBottom > protectionY)
                                    
                                    if overlapsX and overlapsY then
                                        -- Calculate new position (move to right edge of protection area)
                                        set newX to protectionRight
                                        set newY to windowY
                                        
                                        -- Ensure new position is within screen bounds
                                        if newX + windowWidth > screenWidth then
                                            set newX to screenWidth - windowWidth
                                        end if
                                        
                                        -- Resize window if it's too wide for available space
                                        if windowWidth > availableWidth and availableWidth > 100 then
                                            set size of currentWindow to {availableWidth, windowHeight}
                                            log "Resized " & processName & " window: " & windowWidth & " → " & availableWidth
                                        end if
                                        
                                        -- Move the window
                                        set position of currentWindow to {newX, newY}
                                        log "Moved " & processName & " window from x:" & windowX & " to x:" & newX
                                        
                                    end if
                                    
                                on error windowError
                                    -- Skip windows that can't be accessed or modified
                                end try
                            end repeat
                        end if
                        
                    on error processError
                        -- Skip processes that can't be accessed
                    end try
                end repeat
            end tell
            
        on error generalError
            log "Protection loop error: " & (generalError as string)
        end try
        
        -- Wait before next check (configurable delay)
        delay 0.5
    end repeat
end run

-- Helper function to check if list contains item
on listContains(lst, item)
    repeat with currentItem in lst
        if currentItem as string is equal to item as string then
            return true
        end if
    end repeat
    return false
end listContains

-- Helper function to convert list to string for logging
on listToString(lst)
    set AppleScript's text item delimiters to ", "
    set result to lst as string
    set AppleScript's text item delimiters to ""
    return result
end listToString
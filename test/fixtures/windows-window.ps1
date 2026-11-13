param([Parameter(Mandatory=$true)][string]$StateFile)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$form=New-Object System.Windows.Forms.Form
$form.Text='Paseo Remote Control offline fixture'
$form.Size=New-Object System.Drawing.Size(620,380)
$form.StartPosition='CenterScreen'
$title=New-Object System.Windows.Forms.Label
$title.Text='Remote Control - disposable offline test window'
$title.SetBounds(20,20,550,32)
$entry=New-Object System.Windows.Forms.TextBox
$entry.Multiline=$true
$entry.SetBounds(20,70,550,150)
$entry.Font=New-Object System.Drawing.Font('Segoe UI',14)
$entry.Add_KeyDown({param($sender,$event) if($event.Control -and $event.KeyCode -eq 'A'){$sender.SelectAll();$event.SuppressKeyPress=$true}})
$button=New-Object System.Windows.Forms.Button
$button.Text='Test click'
$button.SetBounds(20,245,160,45)
$script:clicks=0
$button.Add_Click({$script:clicks++})
$form.Controls.AddRange(@($title,$entry,$button))
$timer=New-Object System.Windows.Forms.Timer
$timer.Interval=50
$timer.Add_Tick({
    $ep=$entry.PointToScreen([System.Drawing.Point]::Empty)
    $bp=$button.PointToScreen([System.Drawing.Point]::Empty)
    $state=@{text=$entry.Text;selectionLength=$entry.SelectionLength;clicks=$script:clicks;window=$form.Handle.ToInt64();entry=@{x=$ep.X+$entry.Width/2;y=$ep.Y+$entry.Height/2};button=@{x=$bp.X+$button.Width/2;y=$bp.Y+$button.Height/2}}
    [System.IO.File]::WriteAllText($StateFile,($state|ConvertTo-Json -Compress -Depth 4),[System.Text.UTF8Encoding]::new($false))
})
$form.Add_Shown({$timer.Start()})
$form.Add_FormClosed({$timer.Stop()})
[System.Windows.Forms.Application]::Run($form)

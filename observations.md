# UX Enhancements Observations


## Setup page

### `CanvasCoach` Component

1. It should be top-left corner (for english) and top-right corder (for arabic) of the canvas. Not bottom-center.
2. It should show only the icon, which can be expanded to reveal its content.
3. It shouldn't be dismissed, it only collapse.
4. I ma not sure when should it expand, on hovering or on clicking. But if clicking, it should show a tip when hovering.

### `StepGuide` component

1. It takes large area of the panel which I wanted to have more room.
2. I am thinking of a similar way as the `CanvasCoach`, to be an icon `?` that can be expanded when clicked to revreal the instructions.
3. Or may be not expanding, but reveals a modal with the instructions and what it is about.
4. In that case, remove it from the panel entirly. And try to find a way or another place for Replay tour.


### `TourOverlay` component

> I am not sure if this is the correct component

1. The tour workes on the already handled mushafs too. Which doesn't reflect a real guide.


### Older Components

1. Clicking `Set as first Quran Page` shows a toast, but clicking `Set as last Quran Page` shows nothing. A feedback will be really apreciated and guide the user well.
2. Clicking `Save page range` should show a message too.


### Enhancents

1. There should be an indication that the first page is selected, saved, last page selected, and saved. This indiation can be shown as step marked as complete, color of the buttons, or anything you see it would give the best feedback.


## Tempalte Page

### `StepGuide` component

1. It should be similar to that of setup page, an icon that shows a modal on click list all the instructions.
2. Remove it from the panel to give more space.

### `CanvasCoach` Component

1. It should be similar to that of setup page.


### Template cards

1. Clicking on the card shows the ignore region, which is not convenient.
2. A card should select the template to handle.
3. Handling a template should be entirly in the second panel (the preview panel).
4. A user starts by selecting the tempalate, and the preview panel shows the currently selected area, underneath it, there should be the button of the add ignored region, when clicked, a second preview element should be shown below, with a red rectangle in the middle (very similar to what is currently used). The new difference is that the user doesn't adjust the ignored area from the main canvas but from the red rectangle in the bottom preview itself. This is very series, since currently when the user is in cutting ignore area mode, he may switch the pages, which leads to bad results, so instead of locking the page, and since the ignored area is already calculated relative to the template size, it would be more convenient to adjust the ignored area from the template itself instead of the canvas. In this case, also, clicking the template card will show all the data and not selecting the ignored area.

### `TourOverlay` component

1. Should add one tip for tools, select tool, hand tool, zooming, and their shortcuts.


## Process Page

### `TourOverlay` component

1. Should add one more for Detection settigns.
2. For bounds, it should guide the user that he can use the dragging to adjust the area, or use the inputs to adjust by pixles.

### `StepGuide` component

1. It should be similar to that of setup page and template page, an icon that shows a modal on click list all the instructions.
2. Remove it from the panel to give more space.

### `CanvasCoach` Component

1. It should be similar to that of setup page and template page.


### Bound card in the Panel

1. Remove the instructions and put it in an expandaple icon or a tiped icon similar to others.

### `AbortCard` Component

1. It is always hidden below the sections above it, unless they are all collapsed.

import os

import fitz  # PyMuPDF

dpi = 300
zoom = dpi / 72.0  # default PDF dpi is 72
matrix = fitz.Matrix(zoom, zoom)

for file in os.listdir("data"):
    if not file.endswith(".pdf"):
        continue
    pdf_path = os.path.join("data", file)
    output_dir = os.path.join("data", file.replace(".pdf", ""))

    if not os.path.exists(output_dir):
        # Ensure the output directory exists
        os.makedirs(output_dir, exist_ok=True)

    # Get the total number of pages in the PDF
    doc = fitz.open(pdf_path)
    total_pages = len(doc)

    if len(os.listdir(output_dir)) == total_pages:
        print(f"Already processed {file}")
        continue

    print(f"Processing {file}")
    print(f"Total pages to process: {total_pages}")

    # Process and save one page at a time
    for page_num in range(total_pages):
        print(f"Processing page {page_num + 1}/{total_pages}")

        # Read only the specific page into memory
        page = doc.load_page(page_num)

        # Render page to an image
        pix = page.get_pixmap(matrix=matrix)

        # Save the page and release memory
        # We use an f-string to ensure consistent naming if needed,
        # e.g., 001.png for easier sorting
        save_path = os.path.join(output_dir, f"{page_num + 1:03d}.png")
        pix.save(save_path)

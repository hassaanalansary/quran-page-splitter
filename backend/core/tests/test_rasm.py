"""A piece's body shape: dots off, by the letter's place in its piece."""

from unittest import TestCase

from core.text.rasm import find_body_shape_of_bodies, find_body_shape_of_paw


class BodyShapeTests(TestCase):
    def test_teeth_and_an_alef_are_one_shape_whatever_their_dots(self):
        shapes = {find_body_shape_of_paw(paw) for paw in ("نا", "با", "تا", "يا", "ثا", "ئا")}
        self.assertEqual(len(shapes), 1)

    def test_a_noon_at_the_end_of_its_piece_is_a_bowl_not_a_tooth(self):
        self.assertNotEqual(find_body_shape_of_paw("من"), find_body_shape_of_paw("مب"))
        self.assertEqual(find_body_shape_of_paw("من"), find_body_shape_of_paw("من"))

    def test_a_final_ya_and_alef_maqsura_share_a_body(self):
        self.assertEqual(find_body_shape_of_paw("فى"), find_body_shape_of_paw("في"))

    def test_qaf_is_feh_shaped_except_at_the_end(self):
        self.assertEqual(find_body_shape_of_paw("قا"), find_body_shape_of_paw("فا"))
        self.assertNotEqual(find_body_shape_of_paw("حق"), find_body_shape_of_paw("حف"))

    def test_alef_forms_are_one_stroke(self):
        self.assertEqual({find_body_shape_of_paw(alef) for alef in "اأإآٱ"}, {"ا"})

    def test_waw_with_hamza_and_ta_marbuta(self):
        self.assertEqual(find_body_shape_of_paw("ؤ"), "و")
        self.assertEqual(find_body_shape_of_paw("ة"), find_body_shape_of_paw("ه"))

    def test_pieces_printed_touching_keep_their_order(self):
        self.assertEqual(find_body_shape_of_bodies(["إ", "لا"]), "ا+لا")

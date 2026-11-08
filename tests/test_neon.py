"""Native neon loop contract: exact GRB stops, duration and seam."""
import importlib.util
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[1]
class Neon(unittest.TestCase):
    def test_reproducible_native_loop(self):
        generator=ROOT/'scratch/colours/generate-neon.py'
        self.assertTrue(generator.exists(), 'A new reproducible neon generator is required')
        spec=importlib.util.spec_from_file_location('neon',generator)
        m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        data=m.generate()
        self.assertEqual(len(data),900)
        self.assertEqual((ROOT/'scratch/colours'/m.NAME).read_bytes(),data)
        palette=[(199,255,62),(53,232,255),(255,77,166),(167,139,250),(255,146,87)]
        for i,(r,g,b) in enumerate(palette):self.assertEqual(tuple(data[i*180:i*180+3]),(g,r,b))
        steps=[max(abs(a-b) for a,b in zip(data[i:i+3],data[(i+3)%900:(i+3)%900+3])) for i in range(0,900,3)]
        self.assertLessEqual(max(steps),6)
        self.assertLessEqual(steps[-1],1)
        self.assertTrue(m.NAME.endswith('.30fps.10g.0dv'))
if __name__=='__main__':unittest.main()

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { slugify } from '../common/utils/slugify';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';

@Injectable()
export class BrandsService {
  constructor(private prisma: PrismaService) {}

  async findAllPublic() {
    return this.prisma.brand.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, slug: true, logoUrl: true },
    });
  }

  async findAllAdmin() {
    return this.prisma.brand.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true } } },
    });
  }

  async findOne(id: string) {
    const brand = await this.prisma.brand.findUnique({ where: { id } });
    if (!brand) throw new NotFoundException('Marca não encontrada.');
    return brand;
  }

  async create(dto: CreateBrandDto) {
    const slug = dto.slug ? slugify(dto.slug) : slugify(dto.name);
    await this.ensureSlugAvailable(slug);
    return this.prisma.brand.create({ data: { ...dto, slug } });
  }

  async update(id: string, dto: UpdateBrandDto) {
    await this.findOne(id);
    const slug = dto.slug ? slugify(dto.slug) : undefined;
    if (slug) await this.ensureSlugAvailable(slug, id);
    return this.prisma.brand.update({ where: { id }, data: { ...dto, ...(slug && { slug }) } });
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.brand.delete({ where: { id } });
    return { success: true };
  }

  private async ensureSlugAvailable(slug: string, ignoreId?: string) {
    const existing = await this.prisma.brand.findUnique({ where: { slug } });
    if (existing && existing.id !== ignoreId) {
      throw new ConflictException('Já existe uma marca com este slug.');
    }
  }
}

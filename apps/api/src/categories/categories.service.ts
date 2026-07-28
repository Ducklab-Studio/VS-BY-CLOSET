import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { slugify } from '../common/utils/slugify';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@Injectable()
export class CategoriesService {
  constructor(private prisma: PrismaService) {}

  /** Árvore de categorias ativas para navegação pública. */
  async findAllPublic() {
    return this.prisma.category.findMany({
      where: { isActive: true },
      orderBy: { position: 'asc' },
      select: { id: true, name: true, slug: true, imageUrl: true, parentId: true },
    });
  }

  /** Lista completa (todas, ativas ou não) para o admin. */
  async findAllAdmin() {
    return this.prisma.category.findMany({
      orderBy: { position: 'asc' },
      include: { _count: { select: { products: true, children: true } } },
    });
  }

  async findOne(id: string) {
    const category = await this.prisma.category.findUnique({ where: { id } });
    if (!category) throw new NotFoundException('Categoria não encontrada.');
    return category;
  }

  async create(dto: CreateCategoryDto) {
    const slug = dto.slug ? slugify(dto.slug) : slugify(dto.name);
    await this.ensureSlugAvailable(slug);
    return this.prisma.category.create({
      data: { ...dto, slug },
    });
  }

  async update(id: string, dto: UpdateCategoryDto) {
    await this.findOne(id);
    const slug = dto.slug ? slugify(dto.slug) : undefined;
    if (slug) await this.ensureSlugAvailable(slug, id);
    return this.prisma.category.update({
      where: { id },
      data: { ...dto, ...(slug && { slug }) },
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    const childCount = await this.prisma.category.count({ where: { parentId: id } });
    if (childCount > 0) {
      throw new ConflictException('Remova ou realoque as subcategorias antes de excluir esta categoria.');
    }
    await this.prisma.category.delete({ where: { id } });
    return { success: true };
  }

  private async ensureSlugAvailable(slug: string, ignoreId?: string) {
    const existing = await this.prisma.category.findUnique({ where: { slug } });
    if (existing && existing.id !== ignoreId) {
      throw new ConflictException('Já existe uma categoria com este slug.');
    }
  }
}
